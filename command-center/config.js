// =====================================================================
// Configuration publique du Command Center.
//
// Ces deux valeurs viennent du NOUVEAU projet Supabase (celui du Command
// Center), pas de celui du Portail. Dashboard Supabase → Project
// Settings → API.
//
// La clé « anon » est conçue pour être publique : elle apparaît en clair
// ici, c'est normal. Ce qui protège les données, c'est le RLS (un compte
// non rattaché à un membre ne voit rien) — jamais le secret de cette clé.
// La clé service_role, elle, ne doit JAMAIS apparaître dans ce fichier.
// =====================================================================

window.CC_CONFIG = {
  SUPABASE_URL: "https://mtvyimmefayjzlzxudmi.supabase.co",
  SUPABASE_ANON_KEY: "REMPLACER_PAR_LA_CLE_ANON",
};
