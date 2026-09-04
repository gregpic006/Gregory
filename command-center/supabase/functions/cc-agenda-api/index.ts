// =====================================================================
// cc-agenda-api — trouver un créneau, poser un rendez-vous
//
// Le vrai coût d'un rendez-vous n'est pas de l'inscrire à l'agenda,
// c'est de trouver quand. Cette fonction interroge la disponibilité
// réelle des personnes concernées via l'API freeBusy de Google — donc en
// tenant compte de leurs agendas personnels, que le Command Center ne
// lit pas et n'a pas à lire.
// =====================================================================

import {
  corsHeadersFor, json, requireMember, db, setting, googleAccessToken, type GoogleAccount,
} from "../_shared/cc.ts";
import { freeBusy } from "../_shared/google.ts";
import { applyAction } from "../_shared/actions.ts";

const SELECT_ACCOUNT = "id,member_id,google_email,refresh_token_enc,access_token_enc,"
  + "access_token_expires,granted_scopes,status,last_sync_at";

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  try {
    const auth = await requireMember(req);
    if (!auth.ok) return json({ error: auth.error }, auth.status, cors);
    const { member } = auth;

    const body = await req.json().catch(() => ({}));
    const action: string = body.action ?? "";

    switch (action) {
      // -------------------------------------------------------------
      case "find_slots": {
        const memberIds: string[] = body.member_ids?.length ? body.member_ids : [member.id];
        const durationMin: number = Math.max(15, Math.min(480, body.duration_minutes ?? 30));
        const daysAhead: number = Math.max(1, Math.min(30, body.days_ahead ?? 10));

        const accounts = await db<GoogleAccount>(
          `google_accounts?member_id=in.(${memberIds.map((i) => `"${i}"`).join(",")})`
          + `&status=eq.active&select=${SELECT_ACCOUNT}`);
        if (!accounts.length) return json({ error: "Aucun compte Google actif parmi les personnes visées." }, 400, cors);

        const from = new Date();
        const to = new Date(Date.now() + daysAhead * 86400_000);
        // On interroge Google avec le jeton d'un seul compte : freeBusy
        // renvoie la disponibilité de tous les agendas demandés dès lors
        // qu'ils sont dans la même organisation Workspace.
        const token = await googleAccessToken(accounts[0]);
        const busyData = await freeBusy(token, accounts.map((a) => a.google_email),
          from.toISOString(), to.toISOString());

        const busy: { start: number; end: number }[] = [];
        for (const cal of Object.values(busyData.calendars ?? {})) {
          for (const b of cal.busy ?? []) {
            busy.push({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() });
          }
        }
        busy.sort((a, b) => a.start - b.start);

        // Heures ouvrables locales, en semaine. Proposer un créneau à
        // 22 h un dimanche serait techniquement libre et humainement
        // inutile.
        const tz = await setting<string>("timezone", "America/Toronto");

        // On lit l'heure locale via Intl plutôt qu'en reconstruisant une
        // Date à partir d'une chaîne localisée : ce détour classique
        // dépend du fuseau du serveur et se casse silencieusement quand
        // il change (ou au passage à l'heure d'été).
        const fmt = new Intl.DateTimeFormat("en-CA", {
          timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
        });
        const localParts = (ms: number) => {
          const parts = Object.fromEntries(
            fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
          return {
            weekday: parts.weekday,
            minutes: Number(parts.hour) * 60 + Number(parts.minute),
          };
        };
        const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

        const slots: { start: string; end: string }[] = [];
        const stepMs = 30 * 60_000;
        const durMs = durationMin * 60_000;

        // On part de la prochaine demi-heure ronde, au moins une heure
        // plus tard : personne ne réserve un rendez-vous dans 5 minutes.
        let cursor = Math.ceil((Date.now() + 3600_000) / stepMs) * stepMs;
        const limit = to.getTime();
        while (cursor < limit && slots.length < 12) {
          const { weekday, minutes } = localParts(cursor);
          const inHours = WEEKDAYS.includes(weekday)
            && minutes >= 9 * 60 && minutes + durationMin <= 17 * 60;

          if (inHours) {
            const overlaps = busy.some((b) => cursor < b.end && cursor + durMs > b.start);
            if (!overlaps) {
              slots.push({
                start: new Date(cursor).toISOString(),
                end: new Date(cursor + durMs).toISOString(),
              });
              cursor += durMs;
              continue;
            }
          }
          cursor += stepMs;
        }

        return json({
          ok: true, slots, duration_minutes: durationMin,
          checked: accounts.map((a) => a.google_email),
        }, 200, cors);
      }

      // -------------------------------------------------------------
      // Poser le rendez-vous passe par applyAction, donc par le même
      // chemin (et le même journal) que si l'IA l'avait proposé.
      case "book": {
        const external = (body.attendees ?? []).length > 0;
        const result = await applyAction(
          external ? "schedule_meeting" : "create_internal_event",
          {
            member_name: body.member_name ?? member.full_name,
            title: body.title,
            description: body.description,
            location: body.location,
            start: body.start,
            end: body.end,
            attendees: body.attendees ?? [],
            task_code: body.task_code,
          },
          { actorMemberId: member.id, rationale: `Créé manuellement par ${member.full_name}.` },
        );
        return json(result, result.ok ? 200 : 400, cors);
      }

      case "reschedule": {
        const result = await applyAction("reschedule_event", {
          event_id: body.event_id, start: body.start, end: body.end, cancel: body.cancel,
        }, { actorMemberId: member.id, rationale: `Modifié par ${member.full_name}.` });
        return json(result, result.ok ? 200 : 400, cors);
      }

      default:
        return json({ error: `Action inconnue : « ${action} ».` }, 400, cors);
    }
  } catch (err) {
    return json({ error: String(err) }, 500, cors);
  }
});
