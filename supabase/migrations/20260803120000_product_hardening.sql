-- Generalização de famílias, papéis e integridade para uso como produto multiusuário.

alter table public.profile_members
  drop constraint if exists profile_members_role_check;
alter table public.profile_members
  add constraint profile_members_role_check
  check (role in ('owner', 'admin', 'member', 'viewer'));

create or replace function public.profile_role(p_profile_id uuid)
returns text language sql security definer stable set search_path = '' as $$
  select role
  from public.profile_members
  where profile_id = p_profile_id and user_id = (select auth.uid())
  limit 1;
$$;

create or replace function public.is_profile_editor(p_profile_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select coalesce(public.profile_role(p_profile_id) in ('owner', 'admin', 'member'), false);
$$;

create or replace function public.is_profile_admin(p_profile_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select coalesce(public.profile_role(p_profile_id) in ('owner', 'admin'), false);
$$;

revoke all on function public.profile_role(uuid) from public;
revoke all on function public.is_profile_editor(uuid) from public;
revoke all on function public.is_profile_admin(uuid) from public;
grant execute on function public.profile_role(uuid) to authenticated;
grant execute on function public.is_profile_editor(uuid) to authenticated;
grant execute on function public.is_profile_admin(uuid) to authenticated;

create table if not exists public.house_cost_shares (
  cost_id uuid not null references public.house_costs(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  percentage numeric(7,6) not null check (percentage >= 0 and percentage <= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (cost_id, user_id)
);
create index if not exists house_cost_shares_profile_idx on public.house_cost_shares(profile_id, user_id);
alter table public.house_cost_shares enable row level security;
create policy house_cost_shares_read on public.house_cost_shares for select to authenticated
  using (public.is_profile_member(profile_id));
create policy house_cost_shares_write on public.house_cost_shares for all to authenticated
  using (public.is_profile_editor(profile_id)) with check (public.is_profile_editor(profile_id));

create or replace function public.fn_create_house_cost(
  p_profile_id uuid,
  p_cost_type text,
  p_name text,
  p_expected_value numeric,
  p_buy_when text,
  p_user_ids uuid[],
  p_percentages numeric[]
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_cost_id uuid;
  v_index integer;
  v_total numeric;
begin
  if not public.is_profile_editor(p_profile_id) then raise exception 'Acesso negado'; end if;
  if p_cost_type not in ('recorrente', 'entrada') then raise exception 'Tipo de custo inválido'; end if;
  if nullif(trim(p_name), '') is null or p_expected_value <= 0 then raise exception 'Preencha o custo e o valor'; end if;
  if cardinality(p_user_ids) = 0 or cardinality(p_user_ids) <> cardinality(p_percentages) then
    raise exception 'Divisão inválida';
  end if;
  if exists (
    select 1 from unnest(p_user_ids) member_id
    where not exists (
      select 1 from public.profile_members
      where profile_id = p_profile_id and user_id = member_id
    )
  ) then raise exception 'Uma pessoa não pertence ao espaço'; end if;
  select coalesce(sum(value), 0) into v_total from unnest(p_percentages) value;
  if abs(v_total - 1) > 0.0001 then raise exception 'A divisão precisa somar 100%%'; end if;

  insert into public.house_costs(profile_id, cost_type, name, expected_value, buy_when)
  values (p_profile_id, p_cost_type::public.house_cost_type, trim(p_name), p_expected_value, nullif(trim(p_buy_when), ''))
  returning id into v_cost_id;

  for v_index in 1..cardinality(p_user_ids) loop
    insert into public.house_cost_shares(cost_id, profile_id, user_id, percentage)
    values (v_cost_id, p_profile_id, p_user_ids[v_index], p_percentages[v_index]);
  end loop;
  return v_cost_id;
end;
$$;
revoke all on function public.fn_create_house_cost(uuid,text,text,numeric,text,uuid[],numeric[]) from public;
grant execute on function public.fn_create_house_cost(uuid,text,text,numeric,text,uuid[],numeric[]) to authenticated;

create or replace function public.fn_validate_transaction_amount_against_splits()
returns trigger language plpgsql set search_path = '' as $$
declare v_total numeric;
begin
  select coalesce(sum(amount), 0) into v_total
  from public.transaction_splits where transaction_id = new.id;
  if v_total > new.amount then
    raise exception 'O valor não pode ficar menor que as divisões existentes';
  end if;
  return new;
end;
$$;
drop trigger if exists validate_transaction_amount_against_splits on public.transactions;
create trigger validate_transaction_amount_against_splits
before update of amount on public.transactions
for each row execute function public.fn_validate_transaction_amount_against_splits();

-- Leitura continua disponível aos membros; escrita passa a respeitar o papel.
drop policy if exists profiles_member on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (public.is_profile_member(id));
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.is_profile_admin(id)) with check (public.is_profile_admin(id));

drop policy if exists income_member on public.income_sources;
create policy income_read on public.income_sources for select to authenticated using (public.is_profile_member(profile_id));
create policy income_write on public.income_sources for all to authenticated using (public.is_profile_editor(profile_id)) with check (public.is_profile_editor(profile_id));

drop policy if exists accounts_member on public.accounts;
create policy accounts_read on public.accounts for select to authenticated using (public.is_profile_member(profile_id));
create policy accounts_write on public.accounts for all to authenticated using (public.is_profile_editor(profile_id)) with check (public.is_profile_editor(profile_id));

drop policy if exists alloc_member on public.allocation_rules;
create policy alloc_read on public.allocation_rules for select to authenticated using (public.is_profile_member(profile_id));
create policy alloc_write on public.allocation_rules for all to authenticated using (public.is_profile_admin(profile_id)) with check (public.is_profile_admin(profile_id));

drop policy if exists goals_member on public.goals;
create policy goals_read on public.goals for select to authenticated using (public.is_profile_member(profile_id));
create policy goals_write on public.goals for all to authenticated using (public.is_profile_editor(profile_id)) with check (public.is_profile_editor(profile_id));

drop policy if exists contrib_member on public.contributions;
create policy contrib_read on public.contributions for select to authenticated using (public.is_profile_member(profile_id));
create policy contrib_write on public.contributions for all to authenticated using (public.is_profile_editor(profile_id)) with check (public.is_profile_editor(profile_id));

drop policy if exists hp_member on public.house_products;
create policy house_products_read on public.house_products for select to authenticated using (public.is_profile_member(profile_id));
create policy house_products_write on public.house_products for all to authenticated using (public.is_profile_editor(profile_id)) with check (public.is_profile_editor(profile_id));

drop policy if exists hc_member on public.house_costs;
create policy house_costs_read on public.house_costs for select to authenticated using (public.is_profile_member(profile_id));
create policy house_costs_write on public.house_costs for all to authenticated using (public.is_profile_editor(profile_id)) with check (public.is_profile_editor(profile_id));

drop policy if exists hbp_member on public.house_bill_payments;
create policy house_bill_payments_read on public.house_bill_payments for select to authenticated using (public.is_profile_member(profile_id));
create policy house_bill_payments_write on public.house_bill_payments for all to authenticated using (public.is_profile_editor(profile_id)) with check (public.is_profile_editor(profile_id));

drop policy if exists assets_member on public.financial_assets;
create policy assets_read on public.financial_assets for select to authenticated using (public.is_profile_member(profile_id));
create policy assets_write on public.financial_assets for all to authenticated using (public.is_profile_editor(profile_id)) with check (public.is_profile_editor(profile_id));

drop policy if exists split_rules_member on public.profile_split_rules;
create policy split_rules_read on public.profile_split_rules for select to authenticated using (public.is_profile_member(profile_id));
create policy split_rules_write on public.profile_split_rules for all to authenticated using (public.is_profile_admin(profile_id)) with check (public.is_profile_admin(profile_id));

drop policy if exists categories_write on public.categories;
create policy categories_write on public.categories for all to authenticated
  using (profile_id is not null and public.is_profile_editor(profile_id))
  with check (profile_id is not null and public.is_profile_editor(profile_id));

drop policy if exists txn_insert on public.transactions;
drop policy if exists txn_update on public.transactions;
drop policy if exists txn_delete on public.transactions;
create policy txn_insert on public.transactions for insert to authenticated
  with check (
    public.is_profile_editor(profile_id)
    and (destination_profile_id is null or public.is_profile_editor(destination_profile_id))
    and (paid_by_user_id is null or paid_by_user_id = (select auth.uid()) or public.is_profile_admin(profile_id))
  );
create policy txn_update on public.transactions for update to authenticated
  using (
    public.is_profile_editor(profile_id)
    and (paid_by_user_id = (select auth.uid()) or public.is_profile_admin(profile_id))
  )
  with check (
    public.is_profile_editor(profile_id)
    and (destination_profile_id is null or public.is_profile_editor(destination_profile_id))
  );
create policy txn_delete on public.transactions for delete to authenticated
  using (
    public.is_profile_editor(profile_id)
    and (paid_by_user_id = (select auth.uid()) or public.is_profile_admin(profile_id))
  );

drop policy if exists transaction_splits_member on public.transaction_splits;
create policy transaction_splits_read on public.transaction_splits for select to authenticated
  using (public.is_profile_member(profile_id));
create policy transaction_splits_insert on public.transaction_splits for insert to authenticated
  with check (public.is_profile_editor(profile_id));
create policy transaction_splits_update on public.transaction_splits for update to authenticated
  using (
    public.is_profile_editor(profile_id)
    and (
      debtor_user_id = (select auth.uid())
      or public.is_profile_admin(profile_id)
      or exists (
        select 1 from public.transactions t
        where t.id = transaction_id and t.paid_by_user_id = (select auth.uid())
      )
    )
  ) with check (public.is_profile_editor(profile_id));
create policy transaction_splits_delete on public.transaction_splits for delete to authenticated
  using (
    public.is_profile_editor(profile_id)
    and (
      debtor_user_id = (select auth.uid())
      or public.is_profile_admin(profile_id)
      or exists (
        select 1 from public.transactions t
        where t.id = transaction_id and t.paid_by_user_id = (select auth.uid())
      )
    )
  );

-- Dados empresariais operacionais: editores. Configuração e repasses: administradores.
drop policy if exists business_clients_member on public.business_clients;
create policy business_clients_read on public.business_clients for select to authenticated using (public.is_profile_member(profile_id));
create policy business_clients_write on public.business_clients for all to authenticated using (public.is_profile_editor(profile_id)) with check (public.is_profile_editor(profile_id));

drop policy if exists business_contracts_member on public.business_contracts;
create policy business_contracts_read on public.business_contracts for select to authenticated using (public.is_profile_member(profile_id));
create policy business_contracts_write on public.business_contracts for all to authenticated using (public.is_profile_editor(profile_id)) with check (public.is_profile_editor(profile_id));

drop policy if exists business_receivables_member on public.business_receivables;
create policy business_receivables_read on public.business_receivables for select to authenticated using (public.is_profile_member(profile_id));
create policy business_receivables_write on public.business_receivables for all to authenticated using (public.is_profile_editor(profile_id)) with check (public.is_profile_editor(profile_id));

drop policy if exists business_matches_member on public.business_payment_matches;
create policy business_matches_read on public.business_payment_matches for select to authenticated using (public.is_profile_member(profile_id));
create policy business_matches_write on public.business_payment_matches for all to authenticated using (public.is_profile_admin(profile_id)) with check (public.is_profile_admin(profile_id));

drop policy if exists business_policies_member on public.business_allocation_policies;
create policy business_policies_read on public.business_allocation_policies for select to authenticated using (public.is_profile_member(profile_id));
create policy business_policies_write on public.business_allocation_policies for all to authenticated using (public.is_profile_admin(profile_id)) with check (public.is_profile_admin(profile_id));

drop policy if exists business_shares_member on public.business_partner_shares;
create policy business_shares_read on public.business_partner_shares for select to authenticated using (public.is_profile_member(profile_id));
create policy business_shares_write on public.business_partner_shares for all to authenticated using (public.is_profile_admin(profile_id)) with check (public.is_profile_admin(profile_id));

drop policy if exists business_payables_member on public.business_partner_payables;
create policy business_payables_read on public.business_partner_payables for select to authenticated using (public.is_profile_member(profile_id));
create policy business_payables_write on public.business_partner_payables for all to authenticated using (public.is_profile_admin(profile_id)) with check (public.is_profile_admin(profile_id));
create or replace function public.fn_manage_profile_member(p_profile_id uuid,p_user_id uuid,p_action text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.profile_members
    where profile_id=p_profile_id and user_id=(select auth.uid()) and role='owner'
  ) then raise exception 'Apenas proprietários'; end if;
  if p_user_id=(select auth.uid()) then raise exception 'Gerencie seu próprio acesso por outro proprietário'; end if;
  if p_action='remove' then
    delete from public.profile_members where profile_id=p_profile_id and user_id=p_user_id;
  elsif p_action in ('owner','admin','member','viewer') then
    update public.profile_members set role=p_action where profile_id=p_profile_id and user_id=p_user_id;
  else
    raise exception 'Ação inválida';
  end if;
end;
$$;
revoke all on function public.fn_manage_profile_member(uuid,uuid,text) from public;
grant execute on function public.fn_manage_profile_member(uuid,uuid,text) to authenticated;
create or replace function public.fn_update_transaction_series(
  p_transaction_id uuid,
  p_scope text,
  p_amount numeric,
  p_description text,
  p_category_id uuid,
  p_transaction_type text,
  p_occurred_at date,
  p_manage_split boolean default false,
  p_debtor_user_id uuid default null,
  p_split_amount numeric default null
) returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_source public.transactions%rowtype;
  v_row public.transactions%rowtype;
  v_target_count integer := 0;
  v_group_total numeric;
  v_split_profile uuid;
begin
  select * into v_source from public.transactions where id = p_transaction_id for update;
  if v_source.id is null then raise exception 'Lançamento não encontrado'; end if;
  if not public.is_profile_editor(v_source.profile_id)
     or not (v_source.paid_by_user_id = (select auth.uid()) or public.is_profile_admin(v_source.profile_id))
  then raise exception 'Acesso negado'; end if;
  if p_scope not in ('current','future','all') then raise exception 'Escopo inválido'; end if;
  if p_amount <= 0 then raise exception 'Informe um valor maior que zero'; end if;
  if p_transaction_type not in ('expense','income','transfer_out','transfer_in','card_payment') then
    raise exception 'Tipo de lançamento inválido';
  end if;
  if p_split_amount is not null and (p_split_amount <= 0 or p_split_amount > p_amount) then
    raise exception 'A parte da pessoa deve ser menor ou igual à parcela';
  end if;

  for v_row in
    select * from public.transactions
    where id = p_transaction_id
       or (
         v_source.installment_group_id is not null
         and installment_group_id = v_source.installment_group_id
         and (
           p_scope = 'all'
           or (p_scope = 'future' and installment_number >= v_source.installment_number)
         )
       )
    order by installment_number
    for update
  loop
    if v_row.id = p_transaction_id and p_manage_split then
      delete from public.transaction_splits where transaction_id = v_row.id;
    elsif v_row.amount <> p_amount and v_row.amount > 0 then
      if p_amount < v_row.amount then
        update public.transaction_splits
        set amount = round(amount * p_amount / v_row.amount, 2)
        where transaction_id = v_row.id;
      end if;
    end if;

    update public.transactions
    set amount = p_amount,
        description = nullif(trim(p_description), ''),
        category_id = p_category_id,
        transaction_type = p_transaction_type,
        occurred_at = case when id = p_transaction_id then p_occurred_at else occurred_at end,
        needs_review = p_transaction_type = 'expense' and p_category_id is null
    where id = v_row.id;

    if v_row.id <> p_transaction_id or not p_manage_split then
      if p_amount > v_row.amount and v_row.amount > 0 then
        update public.transaction_splits
        set amount = round(amount * p_amount / v_row.amount, 2)
        where transaction_id = v_row.id;
      end if;
    end if;

    if v_row.id = p_transaction_id and p_manage_split and p_debtor_user_id is not null and p_split_amount is not null then
      v_split_profile := coalesce(v_row.destination_profile_id, v_row.profile_id);
      insert into public.transaction_splits(transaction_id, profile_id, debtor_user_id, amount, status)
      values (v_row.id, v_split_profile, p_debtor_user_id, p_split_amount, 'pending');
    end if;
    v_target_count := v_target_count + 1;
  end loop;

  if v_source.installment_group_id is not null then
    select sum(amount) into v_group_total
    from public.transactions where installment_group_id = v_source.installment_group_id;
    update public.transactions set total_purchase_amount = v_group_total
    where installment_group_id = v_source.installment_group_id;
  else
    update public.transactions set total_purchase_amount = p_amount where id = p_transaction_id;
  end if;
  return v_target_count;
end;
$$;

revoke all on function public.fn_update_transaction_series(uuid,text,numeric,text,uuid,text,date,boolean,uuid,numeric) from public;
grant execute on function public.fn_update_transaction_series(uuid,text,numeric,text,uuid,text,date,boolean,uuid,numeric) to authenticated;
