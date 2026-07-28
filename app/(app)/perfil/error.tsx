"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function PerfilError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("Falha ao abrir o Perfil.", error);
  }, [error]);

  return (
    <div className="card flex flex-col gap-3" role="alert">
      <div>
        <p className="font-semibold">Não foi possível abrir o Perfil</p>
        <p className="text-sm text-muted mt-1">
          Seus dados continuam seguros. Tente carregar novamente ou volte ao resumo.
        </p>
      </div>
      <button type="button" className="btn w-full" onClick={() => unstable_retry()}>
        Tentar novamente
      </button>
      <Link href="/dashboard" className="btn-secondary w-full text-center">
        Voltar ao resumo
      </Link>
    </div>
  );
}