"""Tests des donnees du centre de commande.

Ce que ces tests protegent: **une carte ne doit jamais montrer un chiffre
qu'on n'a pas**. Chaque volet porte un statut, et l'absence de source est
toujours dite, jamais remplacee par un zero ou une valeur plausible.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from jarvis_core.api.app import create_app
from jarvis_core.config import Settings
from jarvis_core.integrations.google.client import PROVIDER


def _settings(tmp_path: Any, **overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "JARVIS_LLM_PROVIDER": "mock",
        "JARVIS_USER_NAME": "Greg",
        "JARVIS_DATABASE_URL": f"sqlite:///{tmp_path}/data.db",
        "JARVIS_STT_PROVIDER": "null",
        "JARVIS_TTS_PROVIDER": "null",
    }
    base.update(overrides)
    return Settings(**base)


@pytest.fixture()
def client(tmp_path: Any) -> Iterator[TestClient]:
    with TestClient(create_app(_settings(tmp_path))) as test_client:
        yield test_client


# =============================================================================
# Honnetete des volets
# =============================================================================


def test_absent_sources_are_declared_not_invented(client: TestClient) -> None:
    panes = client.get("/api/overview").json()["panes"]

    assert panes["today"]["status"] == "not_connected"
    assert panes["today"]["events"] == []
    assert "Calendar" in panes["today"]["detail"]

    assert panes["email"]["status"] == "not_connected"
    assert panes["email"]["messages"] == []
    assert "Gmail" in panes["email"]["detail"]

    assert panes["business"]["status"] == "not_connected"


def test_local_sources_are_connected_even_without_google(client: TestClient) -> None:
    """Rappels et memoire sont locaux: ils repondent toujours."""
    panes = client.get("/api/overview").json()["panes"]
    assert panes["tasks"]["status"] == "connected"
    assert panes["memory"]["status"] == "connected"


def test_reminders_appear_in_the_overview(client: TestClient) -> None:
    client.post(
        "/api/chat",
        json={"text": "rappelle-moi d appeler mon comptable demain matin", "session_id": "s"},
    )
    tasks = client.get("/api/overview").json()["panes"]["tasks"]
    assert tasks["status"] == "connected"
    assert any("comptable" in reminder["text"] for reminder in tasks["reminders"])


def test_google_failure_is_an_error_not_an_empty_list(tmp_path: Any) -> None:
    """Une panne d'API doit se distinguer d'une absence de rendez-vous.

    C'est la difference entre « tu n'as rien demain » et « je n'ai pas pu
    regarder » — la premiere phrase serait un mensonge.
    """
    settings = _settings(
        tmp_path,
        JARVIS_FEATURE_CALENDAR=True,
        JARVIS_FEATURE_GMAIL=True,
        GOOGLE_CLIENT_ID="cid",
        GOOGLE_CLIENT_SECRET="secret",
    )
    app = create_app(settings)
    with TestClient(app) as client:
        runtime = app.state.runtime
        # Compte connecte, mais l'API repond 500.
        runtime.google.tokens.save(
            provider=PROVIDER, account="greg@example.com", access_token="at",
            refresh_token="rt", token_type="Bearer",
            scopes=[
                "https://www.googleapis.com/auth/calendar.events",
                "https://www.googleapis.com/auth/gmail.readonly",
            ],
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        runtime.google.client._http = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(500, text="boom"))
        )
        panes = client.get("/api/overview").json()["panes"]

    assert panes["today"]["status"] == "error"
    assert panes["today"]["events"] == []
    assert panes["email"]["status"] == "error"


def test_disconnected_google_is_reported_as_such(tmp_path: Any) -> None:
    settings = _settings(tmp_path, JARVIS_FEATURE_CALENDAR=True)
    with TestClient(create_app(settings)) as client:
        today = client.get("/api/overview").json()["panes"]["today"]
    assert today["status"] == "not_connected"
    assert "Aucun compte Google" in today["detail"]


# =============================================================================
# Entreprises
# =============================================================================


def test_business_metrics_carry_no_invented_value(client: TestClient) -> None:
    payload = client.get("/api/businesses").json()
    names = {org["name"] for org in payload["organizations"]}
    assert {"Grande Allee", "Maguire", "Portail"} <= names
    # Bouvier n'appartient pas a l'utilisateur: la migration 0007 le retire.
    assert "Bouvier" not in names

    for org in payload["organizations"]:
        assert org["metrics"], f"{org['name']} devrait declarer ses indicateurs"
        for metric in org["metrics"]:
            assert metric["status"] == "not_connected"
            assert metric["value"] is None, "aucune valeur ne doit etre fabriquee"


def test_personal_organization_is_not_a_business(client: TestClient) -> None:
    payload = client.get("/api/businesses").json()
    assert all(org["id"] != "PERSONAL" for org in payload["organizations"])


# =============================================================================
# Memoire
# =============================================================================


def test_memory_is_listed_with_its_sources(client: TestClient) -> None:
    client.post(
        "/api/chat",
        json={"text": "retiens que Xavier est mon associe dans Portail", "session_id": "s"},
    )
    payload = client.get("/api/memory").json()
    assert payload["enabled"] is True
    assert payload["memories"], "le souvenir doit apparaitre"
    assert all(memory["source"] for memory in payload["memories"]), "source obligatoire"


def test_memory_can_be_searched_and_forgotten(client: TestClient) -> None:
    client.post(
        "/api/chat",
        json={"text": "retiens que Xavier est mon associe dans Portail", "session_id": "s"},
    )
    found = client.get("/api/memory", params={"query": "Xavier"}).json()["memories"]
    assert found

    memory_id = found[0]["id"]
    assert client.delete(f"/api/memory/{memory_id}").status_code == 200
    assert client.delete(f"/api/memory/{memory_id}").status_code == 404


def test_memory_disabled_is_stated_not_faked(tmp_path: Any) -> None:
    settings = _settings(tmp_path, JARVIS_FEATURE_PERSISTENT_MEMORY=False)
    with TestClient(create_app(settings)) as client:
        payload = client.get("/api/memory").json()
        assert payload["enabled"] is False
        assert payload["memories"] == []
        assert client.delete("/api/memory/whatever").status_code == 400


# =============================================================================
# L'interface compilee est bien servie
# =============================================================================


def test_api_routes_win_over_the_static_mount(client: TestClient) -> None:
    """Le montage de l'interface a la racine ne doit pas masquer l'API."""
    assert client.get("/api/health").json()["status"] == "ok"
    assert client.get("/api/system").status_code == 200
    assert client.get("/api/overview").status_code == 200


# =============================================================================
# Documents (M3)
# =============================================================================


@pytest.fixture()
def docs_client(tmp_path: Any) -> Iterator[TestClient]:
    """Client avec la recherche documentaire active et un dossier reel."""
    folder = tmp_path / "documents"
    folder.mkdir()
    (folder / "bail.md").write_text(
        "# Bail\n\n## Loyer\nLe loyer mensuel est de 4200 dollars par mois.\n",
        encoding="utf-8",
    )
    (folder / "photo.png").write_bytes(b"\x89PNG pas du texte")
    settings = _settings(
        tmp_path,
        JARVIS_FEATURE_DOCUMENTS=True,
        JARVIS_EMBEDDING_ENABLED=False,
        JARVIS_DOCUMENTS_DIR=str(folder),
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def test_documents_disabled_is_stated_not_faked(client: TestClient) -> None:
    """Fonctionnalite eteinte: l'interface le dit au lieu d'afficher un index vide."""
    payload = client.get("/api/documents").json()

    assert payload["enabled"] is False
    assert payload["status"] == "not_connected"
    assert "JARVIS_FEATURE_DOCUMENTS" in payload["detail"]
    assert payload["documents"] == []
    assert payload["search_modes"] == []


def test_documents_pane_appears_in_the_overview(docs_client: TestClient) -> None:
    pane = docs_client.get("/api/overview").json()["panes"]["documents"]

    assert pane["status"] == "connected"
    assert pane["count"] == 0
    # Un index vide dit ou deposer les fichiers plutot que de rester muet.
    assert "documents" in pane["detail"].lower()


def test_search_modes_admit_the_absence_of_the_semantic_model(
    docs_client: TestClient,
) -> None:
    """Sans modele charge, l'interface annonce « mots exacts », pas « sens »."""
    payload = docs_client.get("/api/documents").json()

    assert payload["search_modes"] == ["lexical"]
    assert "semantique" not in payload["search_modes"]


def test_reindex_reports_every_skipped_file(docs_client: TestClient) -> None:
    payload = docs_client.post("/api/documents/reindex").json()

    assert payload["report"]["indexed"] == ["bail.md"]
    skipped = {item["name"] for item in payload["report"]["skipped"]}
    assert skipped == {"photo.png"}
    assert payload["total"] == 1


def test_search_returns_passages_with_their_provenance(docs_client: TestClient) -> None:
    docs_client.post("/api/documents/reindex")

    payload = docs_client.get("/api/documents", params={"query": "loyer mensuel"}).json()

    assert payload["hits"], "le passage indexe doit etre retrouve"
    hit = payload["hits"][0]
    assert hit["title"] == "bail"
    assert hit["locator"] == "Loyer"
    assert hit["matched_by"] == ["lexical"]


def test_no_match_keeps_the_index_size_visible(docs_client: TestClient) -> None:
    """« rien trouve » et « rien d'indexe » ne doivent pas se confondre."""
    docs_client.post("/api/documents/reindex")

    payload = docs_client.get("/api/documents", params={"query": "cryptomonnaie"}).json()

    assert payload["hits"] == []
    assert payload["total"] == 1


def test_deleting_an_unknown_document_is_a_404(docs_client: TestClient) -> None:
    assert docs_client.delete("/api/documents/doc_inexistant").status_code == 404


def test_deleting_a_document_removes_it_from_search(docs_client: TestClient) -> None:
    docs_client.post("/api/documents/reindex")
    document_id = docs_client.get("/api/documents").json()["documents"][0]["id"]

    assert docs_client.delete(f"/api/documents/{document_id}").status_code == 200

    payload = docs_client.get("/api/documents", params={"query": "loyer"}).json()
    assert payload["hits"] == []
    assert payload["total"] == 0


def test_reindex_refused_when_the_feature_is_off(client: TestClient) -> None:
    response = client.post("/api/documents/reindex")

    assert response.status_code == 400
    assert "desactivee" in response.json()["detail"]


# =============================================================================
# Business (M4)
# =============================================================================


CSV_SAMPLE = (
    "Date;Ventes;Couverts\n"
    "18/08/2026;6 200,50;142\n"
    "19/08/2026;5 810,25;131\n"
    "oups;1 000,00;10\n"
)


@pytest.fixture()
def biz_client(tmp_path: Any) -> Iterator[TestClient]:
    settings = _settings(tmp_path, JARVIS_FEATURE_BUSINESS=True)
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def test_business_disabled_still_lists_the_expected_metrics(client: TestClient) -> None:
    """La structure existe, les valeurs non: la page reste lisible sans mentir."""
    payload = client.get("/api/businesses").json()

    assert payload["enabled"] is False
    assert "JARVIS_FEATURE_BUSINESS" in payload["note"]
    grande = next(o for o in payload["organizations"] if o["id"] == "RESTAURANT_GA")
    assert [m["label"] for m in grande["metrics"]][:2] == ["Ventes", "Couverts"]
    assert all(m["value"] is None for m in grande["metrics"])
    assert all(m["status"] == "not_connected" for m in grande["metrics"])


def test_every_metric_starts_not_connected(biz_client: TestClient) -> None:
    payload = biz_client.get("/api/businesses").json()

    assert payload["enabled"] is True
    for organization in payload["organizations"]:
        assert organization["latest_day"] == ""
        for metric in organization["metrics"]:
            assert metric["status"] == "not_connected"
            assert metric["value"] is None
            assert metric["display"] is None


def test_import_then_read_shows_real_values_with_coverage(biz_client: TestClient) -> None:
    response = biz_client.post(
        "/api/businesses/RESTAURANT_GA/import",
        files={"file": ("ventes.csv", CSV_SAMPLE, "text/csv")},
    )

    assert response.status_code == 200
    report = response.json()["report"]
    assert report["rows_ok"] == 2
    assert report["rows_failed"] == 1

    payload = biz_client.get("/api/businesses", params={"days": 400}).json()
    grande = next(o for o in payload["organizations"] if o["id"] == "RESTAURANT_GA")
    sales = next(m for m in grande["metrics"] if m["metric"] == "sales")

    assert sales["value"] == 12010.75
    assert sales["days_covered"] == 2
    # La periode demandee depasse largement les donnees: la carte doit le dire.
    assert sales["complete"] is False


def test_import_report_names_the_rejected_line(biz_client: TestClient) -> None:
    report = biz_client.post(
        "/api/businesses/RESTAURANT_GA/import",
        files={"file": ("ventes.csv", CSV_SAMPLE, "text/csv")},
    ).json()["report"]

    assert [error["line"] for error in report["errors"]] == [4]
    assert "date illisible" in report["errors"][0]["reason"]


def test_importing_does_not_leak_into_another_organization(biz_client: TestClient) -> None:
    biz_client.post(
        "/api/businesses/RESTAURANT_GA/import",
        files={"file": ("ventes.csv", CSV_SAMPLE, "text/csv")},
    )

    payload = biz_client.get("/api/businesses", params={"days": 400}).json()
    maguire = next(o for o in payload["organizations"] if o["id"] == "RESTAURANT_MAGUIRE")

    assert all(m["status"] == "not_connected" for m in maguire["metrics"])


def test_import_to_an_unknown_organization_is_a_404(biz_client: TestClient) -> None:
    response = biz_client.post(
        "/api/businesses/PAS_UNE_ENTREPRISE/import",
        files={"file": ("ventes.csv", CSV_SAMPLE, "text/csv")},
    )

    assert response.status_code == 404


def test_import_refused_when_the_feature_is_off(client: TestClient) -> None:
    response = client.post(
        "/api/businesses/RESTAURANT_GA/import",
        files={"file": ("ventes.csv", CSV_SAMPLE, "text/csv")},
    )

    assert response.status_code == 400


def test_unreadable_file_is_refused_with_a_reason(biz_client: TestClient) -> None:
    response = biz_client.post(
        "/api/businesses/RESTAURANT_GA/import",
        files={"file": ("meteo.csv", "Date;Meteo\n18/08/2026;pluie\n", "text/csv")},
    )

    assert response.status_code == 400
    assert "Aucune colonne reconnue" in response.json()["detail"]


def test_clearing_data_returns_the_metrics_to_not_connected(biz_client: TestClient) -> None:
    biz_client.post(
        "/api/businesses/RESTAURANT_GA/import",
        files={"file": ("ventes.csv", CSV_SAMPLE, "text/csv")},
    )

    assert biz_client.delete("/api/businesses/RESTAURANT_GA/data").status_code == 200

    payload = biz_client.get("/api/businesses", params={"days": 400}).json()
    grande = next(o for o in payload["organizations"] if o["id"] == "RESTAURANT_GA")
    assert all(m["status"] == "not_connected" for m in grande["metrics"])


# =============================================================================
# Reglages modifiables depuis l'interface
# =============================================================================


@pytest.fixture()
def settings_client(tmp_path: Any, monkeypatch: Any) -> Iterator[TestClient]:
    """Client dont le `.env` est un fichier jetable, contenant un faux secret."""
    env = tmp_path / ".env"
    env.write_text(
        "# Ne jamais toucher\n"
        "ANTHROPIC_API_KEY=sk-ant-SECRET\n"
        "GOOGLE_CLIENT_SECRET=GOCSPX-SECRET\n"
        "\n"
        "JARVIS_FEATURE_DOCUMENTS=false\n"
        "JARVIS_FEATURE_BUSINESS=false\n",
        encoding="utf-8",
    )
    (tmp_path / ".env.example").write_text("JARVIS_FEATURE_DOCUMENTS=false\n", encoding="utf-8")
    monkeypatch.setattr(
        "jarvis_core.api.routes_settings.find_project_root", lambda: tmp_path
    )
    with TestClient(create_app(_settings(tmp_path))) as test_client:
        yield test_client


def test_settings_never_expose_a_secret(settings_client: TestClient) -> None:
    payload = settings_client.get("/api/settings").json()

    serialized = str(payload)
    assert "sk-ant-" not in serialized
    assert "GOCSPX-" not in serialized
    # La presence est dite, la valeur jamais.
    assert "anthropic_key_present" in payload


def test_toggling_a_feature_writes_to_env(settings_client: TestClient, tmp_path: Any) -> None:
    response = settings_client.patch(
        "/api/settings", json={"features": {"JARVIS_FEATURE_BUSINESS": True}}
    )

    assert response.status_code == 200
    assert response.json()["changed"] == ["JARVIS_FEATURE_BUSINESS"]
    assert response.json()["restart_needed"] is True
    assert "JARVIS_FEATURE_BUSINESS=true" in (tmp_path / ".env").read_text(encoding="utf-8")


def test_toggling_never_damages_the_secrets(settings_client: TestClient, tmp_path: Any) -> None:
    """Le fichier contient des cles irrecuperables: elles doivent survivre intactes."""
    settings_client.patch(
        "/api/settings", json={"features": {"JARVIS_FEATURE_DOCUMENTS": True}}
    )

    content = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "ANTHROPIC_API_KEY=sk-ant-SECRET" in content
    assert "GOOGLE_CLIENT_SECRET=GOCSPX-SECRET" in content
    assert "# Ne jamais toucher" in content


def test_an_unlisted_variable_cannot_be_written(settings_client: TestClient) -> None:
    """Le controle de l'ordinateur ne doit pas s'activer via l'API."""
    response = settings_client.patch(
        "/api/settings", json={"features": {"JARVIS_FEATURE_COMPUTER_CONTROL": True}}
    )

    assert response.status_code == 400
    assert "non modifiable" in response.json()["detail"]


def test_an_api_key_cannot_be_written_through_settings(settings_client: TestClient) -> None:
    response = settings_client.patch(
        "/api/settings", json={"features": {"ANTHROPIC_API_KEY": True}}
    )

    assert response.status_code == 400


def test_enabling_google_asks_for_a_reconnection(settings_client: TestClient) -> None:
    """Une nouvelle portee OAuth ne s'applique qu'apres un nouveau consentement."""
    response = settings_client.patch(
        "/api/settings", json={"features": {"JARVIS_FEATURE_DRIVE": True}}
    )

    assert response.json()["reconnect_google"] is True


def test_disabling_does_not_ask_for_a_reconnection(settings_client: TestClient) -> None:
    settings_client.patch("/api/settings", json={"features": {"JARVIS_FEATURE_DRIVE": True}})

    response = settings_client.patch(
        "/api/settings", json={"features": {"JARVIS_FEATURE_DRIVE": False}}
    )

    assert response.json()["reconnect_google"] is False


def test_an_empty_documents_folder_is_refused(settings_client: TestClient) -> None:
    response = settings_client.patch("/api/settings", json={"documents_dir": "   "})

    assert response.status_code == 400


def test_setting_the_same_value_changes_nothing(settings_client: TestClient) -> None:
    settings_client.patch("/api/settings", json={"features": {"JARVIS_FEATURE_BUSINESS": True}})

    response = settings_client.patch(
        "/api/settings", json={"features": {"JARVIS_FEATURE_BUSINESS": True}}
    )

    assert response.json()["changed"] == []
    assert response.json()["restart_needed"] is False


# =============================================================================
# Les entreprises appartiennent a l'utilisateur
# =============================================================================


def test_creating_an_organization(biz_client: TestClient) -> None:
    response = biz_client.post(
        "/api/businesses", json={"name": "Chez Gaston", "kind": "restaurant"}
    )

    assert response.status_code == 201
    created = response.json()
    assert created["id"] == "CHEZ_GASTON"

    names = {o["name"] for o in biz_client.get("/api/businesses").json()["organizations"]}
    assert "Chez Gaston" in names


def test_two_similar_names_do_not_collide(biz_client: TestClient) -> None:
    """Sans suffixe, la seconde ecraserait silencieusement la premiere."""
    first = biz_client.post("/api/businesses", json={"name": "Le Bistro"}).json()
    second = biz_client.post("/api/businesses", json={"name": "Le Bistro"}).json()

    assert first["id"] == "LE_BISTRO"
    assert second["id"] == "LE_BISTRO_2"


def test_accents_are_handled_in_identifiers(biz_client: TestClient) -> None:
    created = biz_client.post("/api/businesses", json={"name": "Café Été"}).json()

    assert created["id"] == "CAFE_ETE"
    assert created["name"] == "Café Été"


def test_an_unknown_kind_is_refused(biz_client: TestClient) -> None:
    response = biz_client.post("/api/businesses", json={"name": "X", "kind": "banque"})

    assert response.status_code == 400
    assert "Type inconnu" in response.json()["detail"]


def test_renaming_an_organization(biz_client: TestClient) -> None:
    response = biz_client.patch(
        "/api/businesses/RESTAURANT_GA", json={"name": "Grande-Allee", "kind": "restaurant"}
    )

    assert response.status_code == 200
    names = {o["name"] for o in biz_client.get("/api/businesses").json()["organizations"]}
    assert "Grande-Allee" in names


def test_archiving_hides_without_destroying(biz_client: TestClient) -> None:
    """On ne detruit pas des annees de chiffres sur un clic."""
    biz_client.post(
        "/api/businesses/RESTAURANT_GA/import",
        files={"file": ("v.csv", CSV_SAMPLE, "text/csv")},
    )

    assert biz_client.delete("/api/businesses/RESTAURANT_GA").json() == {
        "archived": "RESTAURANT_GA"
    }
    ids = {o["id"] for o in biz_client.get("/api/businesses").json()["organizations"]}
    assert "RESTAURANT_GA" not in ids

    assert biz_client.post("/api/businesses/RESTAURANT_GA/restore").status_code == 200
    payload = biz_client.get("/api/businesses", params={"days": 400}).json()
    grande = next(o for o in payload["organizations"] if o["id"] == "RESTAURANT_GA")
    sales = next(m for m in grande["metrics"] if m["metric"] == "sales")
    assert sales["value"] == 12010.75, "les chiffres doivent avoir survecu"


def test_purging_is_explicit_and_final(biz_client: TestClient) -> None:
    biz_client.post(
        "/api/businesses/RESTAURANT_GA/import",
        files={"file": ("v.csv", CSV_SAMPLE, "text/csv")},
    )

    assert biz_client.delete(
        "/api/businesses/RESTAURANT_GA", params={"purge": "true"}
    ).json() == {"purged": "RESTAURANT_GA"}
    assert biz_client.post("/api/businesses/RESTAURANT_GA/restore").status_code == 404


def test_the_personal_context_cannot_be_removed(biz_client: TestClient) -> None:
    response = biz_client.delete("/api/businesses/PERSONAL")

    assert response.status_code == 400


def test_an_archived_organization_produces_no_alert(biz_client: TestClient) -> None:
    """Une entreprise retiree ne doit plus rien signaler."""
    biz_client.delete("/api/businesses/RESTAURANT_GA")

    payload = biz_client.post("/api/alerts/check").json()

    assert all("Grande Allee" not in alert["title"] for alert in payload["new"])


def test_business_pane_reflects_reality_after_an_import(biz_client: TestClient) -> None:
    """Ce volet repondait « non connecte » en dur, meme avec des donnees reelles."""
    before = biz_client.get("/api/overview").json()["panes"]["business"]
    assert before["status"] == "not_connected"
    assert before["connected_count"] == 0

    biz_client.post(
        "/api/businesses/RESTAURANT_GA/import",
        files={"file": ("v.csv", CSV_SAMPLE, "text/csv")},
    )

    after = biz_client.get("/api/overview").json()["panes"]["business"]
    assert after["status"] == "connected"
    assert after["connected_count"] == 1
    assert "Grande Allee" in after["detail"]


def test_business_pane_says_disabled_rather_than_empty(client: TestClient) -> None:
    pane = client.get("/api/overview").json()["panes"]["business"]

    assert pane["status"] == "not_connected"
    assert "JARVIS_FEATURE_BUSINESS" in pane["detail"]


def test_a_newly_created_organization_appears_in_the_overview(
    biz_client: TestClient,
) -> None:
    biz_client.post("/api/businesses", json={"name": "Chez Gaston"})

    pane = biz_client.get("/api/overview").json()["panes"]["business"]

    assert "Chez Gaston" in {org["name"] for org in pane["organizations"]}
