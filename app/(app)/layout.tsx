import Link from "next/link";
import { getContext } from "@/lib/profiles";
import { respondProfileInvitation, switchProfile } from "./actions";
import { BottomNav } from "./BottomNav";
import { DisplayControls } from "./DisplayControls";

type PendingInvitation = { invitation_id: string; profile_name: string; invited_email: string; invited_by_name: string };
type Theme = "system" | "light" | "dark";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { supabase, profiles, active, userId } = await getContext();
  const [{ data: invitations }, { data: settings }] = await Promise.all([
    supabase.rpc("fn_pending_profile_invitations"),
    active ? supabase.from("profile_user_settings").select("theme,hide_values").eq("profile_id", active.id).eq("user_id", userId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  return <div className="mx-auto w-full max-w-lg min-h-screen flex flex-col pb-[calc(6rem+env(safe-area-inset-bottom))]">
    <header className="app-header px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3 flex items-center gap-2" aria-label="Espaço financeiro ativo">
      <div className="flex gap-2 overflow-x-auto flex-1 pb-1">{profiles.map((profile) => {
        const isActive = profile.id === active?.id;
        return <form action={switchProfile} key={profile.id}><input type="hidden" name="profileId" value={profile.id} /><input type="hidden" name="next" value="/dashboard" /><button type="submit" className={`profile-chip gap-2 ${isActive ? "profile-chip-active" : ""}`} aria-pressed={isActive}><span className="size-2.5 rounded-full border border-current/20" style={{ background: profile.color ?? "var(--brand)" }} />{profile.name}</button></form>;
      })}</div>
      <DisplayControls key={active?.id ?? "none"} profileId={active?.id ?? ""} initialTheme={(settings?.theme ?? "system") as Theme} initialHidden={Boolean(settings?.hide_values)} />
      <Link href="/perfil" className="avatar-control" aria-label="Abrir perfil">{active?.name.slice(0, 1).toUpperCase() ?? "P"}</Link>
    </header>
    <main id="main-content" className="flex-1 px-4" tabIndex={-1}>
      {((invitations ?? []) as PendingInvitation[]).map((invitation) => <section key={invitation.invitation_id} className="card mb-4 border-brand"><p className="eyebrow text-brand">Novo convite</p><h2 className="font-semibold mt-1">Participar de {invitation.profile_name}?</h2><p className="text-xs text-muted mt-1">{invitation.invited_by_name} convidou {invitation.invited_email}.</p><form action={respondProfileInvitation} className="grid grid-cols-2 gap-2 mt-3"><input type="hidden" name="invitation_id" value={invitation.invitation_id} /><button name="decision" value="decline" className="btn-secondary">Recusar</button><button name="decision" value="accept" className="btn">Aceitar</button></form></section>)}
      {children}
    </main>
    <BottomNav contextType={active?.context_type ?? "personal"} />
  </div>;
}
