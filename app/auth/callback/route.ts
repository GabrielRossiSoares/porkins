import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptToken } from "@/lib/gmail/crypto";

function safeNext(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/dashboard";
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  const requestedProfileId = request.nextUrl.searchParams.get("profile");
  const errorUrl = new URL("/login", request.url);
  if (!code) {
    errorUrl.searchParams.set("erro", "O Google não retornou um código de acesso.");
    return NextResponse.redirect(errorUrl);
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.user || !data.session) {
      errorUrl.searchParams.set("erro", "Não foi possível concluir o acesso com Google.");
      return NextResponse.redirect(errorUrl);
    }

    let existingConnectionProfileId: string | null = null;
    try {
      const { data: existingConnection } = await createAdminClient()
        .from("gmail_connections")
        .select("profile_id")
        .eq("user_id", data.user.id)
        .maybeSingle();
      existingConnectionProfileId = existingConnection?.profile_id ?? null;
    } catch (connectionError) {
      console.error("Não foi possível consultar a conexão Gmail durante o login.", connectionError);
    }

    const { data: profiles, error: profilesError } = await supabase.from("profiles").select("id,type");
    if (profilesError) {
      await supabase.auth.signOut();
      errorUrl.searchParams.set("erro", "Não foi possível carregar seu perfil financeiro.");
      return NextResponse.redirect(errorUrl);
    }

    const profile = profiles?.find((item) => item.id === requestedProfileId)
      ?? profiles?.find((item) => item.id === existingConnectionProfileId)
      ?? profiles?.find((item) => item.type === "pessoal")
      ?? profiles?.[0];
    if (!profile) {
      await supabase.auth.signOut();
      errorUrl.searchParams.set("erro", "Este Gmail ainda não está vinculado. Entre uma última vez com senha e conecte-o em Perfil.");
      return NextResponse.redirect(errorUrl);
    }

    const googleIdentity = data.user.identities?.find((identity) => identity.provider === "google");
    const gmailEmail = String(googleIdentity?.identity_data?.email ?? data.user.email ?? "").toLowerCase();
    const refreshToken = data.session.provider_refresh_token;
    if (gmailEmail && refreshToken) {
      try {
        const admin = createAdminClient();
        const { error: saveError } = await admin.from("gmail_connections").upsert({
          user_id: data.user.id,
          profile_id: profile.id,
          gmail_email: gmailEmail,
          encrypted_refresh_token: encryptToken(refreshToken),
          last_error: null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });
        if (saveError) throw saveError;

        const { data: defaultRoute, error: routeLookupError } = await admin
          .from("gmail_import_routes")
          .select("id")
          .eq("user_id", data.user.id)
          .eq("is_default", true)
          .eq("active", true)
          .maybeSingle();
        if (routeLookupError) throw routeLookupError;

        if (!defaultRoute) {
          const { error: routeSaveError } = await admin.from("gmail_import_routes").upsert({
            user_id: data.user.id,
            profile_id: profile.id,
            match_label: "*",
            is_default: true,
          }, { onConflict: "user_id,profile_id,match_label" });
          if (routeSaveError) throw routeSaveError;
        }
      } catch (gmailError) {
        console.error("Login concluído, mas a conexão Gmail não pôde ser preparada.", gmailError);
        const destination = new URL(next, request.url);
        destination.searchParams.set("gmail", "warning");
        return NextResponse.redirect(destination);
      }
    }

    return NextResponse.redirect(new URL(next, request.url));
  } catch (callbackError) {
    console.error("Falha inesperada no callback do Google.", callbackError);
    errorUrl.searchParams.set("erro", "Não foi possível concluir o login. Tente novamente.");
    return NextResponse.redirect(errorUrl);
  }
}