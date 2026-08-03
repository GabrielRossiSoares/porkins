"use client";

import { useState } from "react";
import { addTransaction } from "../actions";
import { SubmitButton } from "../SubmitButton";

type Option = { id: string; name: string };
type Space = { id: string; name: string; contextType: string };
type Member = { userId: string; displayName: string; email: string };

function numberValue(value: string) {
  const normalized = value.replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const result = Number(normalized);
  return Number.isFinite(result) ? result : 0;
}

export function TransactionForm({
  profileId,
  profileName,
  userId,
  accounts,
  categories,
  spaces,
  membersBySpace,
  splitRulesBySpace,
  today,
}: {
  profileId: string;
  profileName: string;
  userId: string;
  accounts: Option[];
  categories: Option[];
  spaces: Space[];
  membersBySpace: Record<string, Member[]>;
  splitRulesBySpace: Record<string, Record<string, number>>;
  today: string;
}) {
  const [destination, setDestination] = useState("");
  const [installmentCount, setInstallmentCount] = useState(1);
  const [amount, setAmount] = useState("");
  const [shares, setShares] = useState<Record<string, number>>({});
  const destinationMembers = (membersBySpace[destination] ?? []).filter((member) => member.userId !== userId);
  const selectedShares = destinationMembers.filter((member) => (shares[member.userId] ?? 0) > 0);
  const sharedPercentage = selectedShares.reduce((sum, member) => sum + (shares[member.userId] ?? 0), 0);
  const splitConfig = JSON.stringify(selectedShares.map((member) => ({
    userId: member.userId,
    percentage: shares[member.userId],
  })));
  const purchaseAmount = numberValue(amount);
  const installmentPreview = installmentCount > 1 && purchaseAmount > 0
    ? purchaseAmount / installmentCount
    : 0;
  const destinationName = spaces.find((space) => space.id === destination)?.name;

  const equalShare = selectedShares.length
    ? Math.floor((100 / (selectedShares.length + 1)) * 100) / 100
    : 0;

  function toggleMember(userIdToToggle: string, checked: boolean) {
    setShares((current) => ({ ...current, [userIdToToggle]: checked ? 50 : 0 }));
  }

  function divideEqually() {
    if (!selectedShares.length) return;
    setShares((current) => {
      const next = { ...current };
      for (const member of selectedShares) next[member.userId] = equalShare;
      return next;
    });
  }

  return (
    <form action={addTransaction} className="card flex flex-col gap-4">
      <input type="hidden" name="profile_id" value={profileId} />
      <input type="hidden" name="transaction_type" value="expense" />
      <input type="hidden" name="split_config" value={splitConfig} />

      <div>
        <label className="label" htmlFor="amount">Valor total da compra (R$)</label>
        <input id="amount" name="amount" type="text" required inputMode="decimal"
          className="input" placeholder="0,00" autoFocus value={amount}
          onChange={(event) => setAmount(event.target.value)} />
      </div>

      <div>
        <label className="label" htmlFor="description">O que foi</label>
        <input id="description" name="description" type="text" className="input"
          placeholder="Ex.: Mercado, notebook da empresa, farmácia..." />
      </div>

      <div>
        <label className="label" htmlFor="category_id">Categoria</label>
        <select id="category_id" name="category_id" className="input" defaultValue="">
          <option value="">Não sei / classificar depois</option>
          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="account_id">Onde foi pago</label>
          <select id="account_id" name="account_id" className="input" defaultValue="">
            <option value="">Sem conta definida</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="occurred_at">Primeira parcela</label>
          <input id="occurred_at" name="occurred_at" type="date" defaultValue={today} className="input" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="installment_count">Quantidade de parcelas</label>
          <input id="installment_count" name="installment_count" type="number" min="1" max="60"
            value={installmentCount} onChange={(event) => setInstallmentCount(Math.max(1, Number(event.target.value) || 1))}
            className="input" inputMode="numeric" />
        </div>
        <div className="surface-muted rounded-xl p-3" aria-live="polite">
          <p className="text-xs text-muted">Como entra no extrato</p>
          <p className="text-sm font-semibold">
            {installmentCount > 1 && purchaseAmount > 0
              ? `${installmentCount}x de aproximadamente ${installmentPreview.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`
              : "Uma única parcela"}
          </p>
        </div>
      </div>

      <fieldset className="rounded-xl border border-border p-3 flex flex-col gap-3">
        <legend className="font-semibold text-sm px-1">Para quem foi esta compra?</legend>
        <p className="text-xs text-muted">
          O pagamento continua em {profileName}. Escolha um espaço para atribuir o gasto à Casa ou à empresa.
        </p>
        <select name="destination_profile_id" aria-label="Espaço beneficiado pela compra" className="input"
          value={destination} onChange={(event) => { const next = event.target.value; setDestination(next); setShares(splitRulesBySpace[next] ?? {}); }}>
          <option value="">Somente para mim</option>
          {spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
        </select>

        {destination && (
          <div className="surface-muted rounded-xl p-3">
            <p className="text-sm font-semibold">Divisão em {destinationName}</p>
            <p className="text-xs text-muted mt-1">Marque quem deve participar e defina a porcentagem dessa pessoa. Sua parte é o restante.</p>
            <div className="flex flex-col gap-3 mt-3">
              {destinationMembers.map((member) => {
                const selected = (shares[member.userId] ?? 0) > 0;
                return (
                  <div key={member.userId} className="grid grid-cols-[1fr_6rem] gap-2 items-center">
                    <label className="flex items-center gap-2 min-h-11">
                      <input type="checkbox" checked={selected} onChange={(event) => toggleMember(member.userId, event.target.checked)} />
                      <span><span className="block text-sm font-semibold">{member.displayName}</span><span className="block text-xs text-muted">{member.email}</span></span>
                    </label>
                    <label className="flex items-center gap-1">
                      <span className="sr-only">Percentual de {member.displayName}</span>
                      <input type="number" min="0.01" max="100" step="0.01" className="input text-right"
                        disabled={!selected} value={selected ? shares[member.userId] : ""}
                        onChange={(event) => setShares((current) => ({ ...current, [member.userId]: Number(event.target.value) || 0 }))} />
                      <span className="text-muted">%</span>
                    </label>
                  </div>
                );
              })}
              {!destinationMembers.length && <p className="text-xs text-warning">Este espaço ainda não tem outro membro. Convide alguém em Perfil e espaços.</p>}
            </div>
            {selectedShares.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border flex items-center justify-between gap-3">
                <div className="text-xs">
                  <p>Outras pessoas: <strong>{sharedPercentage.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%</strong></p>
                  <p className={sharedPercentage > 100 ? "text-danger font-semibold" : "text-muted"}>Sua parte: {Math.max(0, 100 - sharedPercentage).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%</p>
                </div>
                <button type="button" className="btn-secondary text-xs" onClick={divideEqually}>Dividir igualmente</button>
              </div>
            )}
          </div>
        )}
      </fieldset>

      <SubmitButton disabled={sharedPercentage > 100} pendingLabel="Salvando compra...">Salvar compra</SubmitButton>
      <p className="text-xs text-muted text-center">As parcelas serão criadas mês a mês e os acertos aparecerão para cada participante.</p>
    </form>
  );
}
