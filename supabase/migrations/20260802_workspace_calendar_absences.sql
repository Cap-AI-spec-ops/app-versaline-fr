-- Workspace absence calendar foundation (manual entries, role-aware permissions)

begin;

create table if not exists public.workspace_absences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  status text not null default 'confirmed',
  public_note text,
  created_by uuid not null references public.profiles(id),
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_absences_status_check check (status in ('planned', 'confirmed', 'cancelled')),
  constraint workspace_absences_date_check check (starts_on <= ends_on),
  constraint workspace_absences_public_note_len check (public_note is null or char_length(public_note) <= 240)
);

create index if not exists workspace_absences_workspace_dates_idx
  on public.workspace_absences (workspace_id, starts_on, ends_on);

create index if not exists workspace_absences_workspace_profile_idx
  on public.workspace_absences (workspace_id, profile_id, starts_on);

alter table public.workspace_absences enable row level security;

drop policy if exists "workspace_absences_select" on public.workspace_absences;
create policy "workspace_absences_select"
on public.workspace_absences
for select
to authenticated
using (public.can_access_workspace(workspace_id));

drop policy if exists "workspace_absences_insert" on public.workspace_absences;
create policy "workspace_absences_insert"
on public.workspace_absences
for insert
to authenticated
with check (
  public.can_access_workspace(workspace_id)
  and (
    profile_id = auth.uid()
    or public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
  )
);

drop policy if exists "workspace_absences_update" on public.workspace_absences;
create policy "workspace_absences_update"
on public.workspace_absences
for update
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and (
    public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
    or profile_id = auth.uid()
  )
)
with check (
  public.can_access_workspace(workspace_id)
  and (
    public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
    or profile_id = auth.uid()
  )
);

drop policy if exists "workspace_absences_delete" on public.workspace_absences;
create policy "workspace_absences_delete"
on public.workspace_absences
for delete
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and (
    public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
    or profile_id = auth.uid()
  )
);

create or replace function public.get_workspace_absences(
  p_range_start date,
  p_range_end date
)
returns table (
  id uuid,
  workspace_id uuid,
  profile_id uuid,
  first_name text,
  last_name text,
  starts_on date,
  ends_on date,
  status text,
  public_note text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz,
  updated_at timestamptz,
  can_edit boolean,
  can_delete boolean
)
language plpgsql
security definer
set search_path = public, auth
set row_security = off
as $$
declare
  v_workspace_id uuid;
  v_role text;
begin
  if p_range_start is null or p_range_end is null then
    raise exception 'Range start and end dates are required';
  end if;

  if p_range_start > p_range_end then
    raise exception 'Range start cannot be after range end';
  end if;

  select p.workspace_id
  into v_workspace_id
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_workspace_id is null or not public.can_access_workspace(v_workspace_id) then
    return;
  end if;

  v_role := public.resolve_workspace_role(v_workspace_id);

  return query
  select
    a.id,
    a.workspace_id,
    a.profile_id,
    p.first_name,
    p.last_name,
    a.starts_on,
    a.ends_on,
    a.status,
    a.public_note,
    a.created_by,
    a.updated_by,
    a.created_at,
    a.updated_at,
    (v_role in ('super_admin', 'owner', 'team_lead') or a.profile_id = auth.uid()) as can_edit,
    (v_role in ('super_admin', 'owner', 'team_lead') or a.profile_id = auth.uid()) as can_delete
  from public.workspace_absences a
  join public.profiles p on p.id = a.profile_id
  where a.workspace_id = v_workspace_id
    and a.ends_on >= p_range_start
    and a.starts_on <= p_range_end
  order by a.starts_on, a.ends_on, lower(coalesce(p.last_name, '')), lower(coalesce(p.first_name, ''));
end;
$$;

grant execute on function public.get_workspace_absences(date, date) to authenticated;

create or replace function public.create_workspace_absence(
  p_profile_id uuid,
  p_starts_on date,
  p_ends_on date,
  p_status text default 'confirmed',
  p_public_note text default null,
  p_source text default 'calendar_page'
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
set row_security = off
as $$
declare
  v_workspace_id uuid;
  v_role text;
  v_absence public.workspace_absences;
  v_status text := lower(trim(coalesce(p_status, 'confirmed')));
  v_note text := nullif(trim(coalesce(p_public_note, '')), '');
begin
  if p_profile_id is null then
    raise exception 'Profile is required';
  end if;

  if p_starts_on is null or p_ends_on is null then
    raise exception 'Start and end dates are required';
  end if;

  if p_starts_on > p_ends_on then
    raise exception 'Start date cannot be after end date';
  end if;

  if v_status not in ('planned', 'confirmed', 'cancelled') then
    v_status := 'confirmed';
  end if;

  select workspace_id into v_workspace_id from public.profiles where id = auth.uid() limit 1;

  if v_workspace_id is null or not public.can_access_workspace(v_workspace_id) then
    raise exception 'Could not resolve workspace access';
  end if;

  if not exists (
    select 1
    from public.workspace_memberships m
    where m.user_id = p_profile_id
      and m.workspace_id = v_workspace_id
      and m.status = 'active'
  ) then
    raise exception 'Selected coworker is not an active member of this workspace';
  end if;

  v_role := public.resolve_workspace_role(v_workspace_id);

  if p_profile_id <> auth.uid() and v_role not in ('super_admin', 'owner', 'team_lead') then
    raise exception 'Only team leads, owners, and super admins can create absences for coworkers';
  end if;

  insert into public.workspace_absences (
    workspace_id,
    profile_id,
    starts_on,
    ends_on,
    status,
    public_note,
    created_by,
    updated_by
  )
  values (
    v_workspace_id,
    p_profile_id,
    p_starts_on,
    p_ends_on,
    v_status,
    v_note,
    auth.uid(),
    auth.uid()
  )
  returning * into v_absence;

  perform public.write_audit_log(
    p_action => 'workspace_absence_created',
    p_workspace_id => v_workspace_id,
    p_target_type => 'workspace_absence',
    p_target_id => v_absence.id::text,
    p_metadata => jsonb_build_object(
      'absence_id', v_absence.id,
      'profile_id', v_absence.profile_id,
      'starts_on', v_absence.starts_on,
      'ends_on', v_absence.ends_on,
      'status', v_absence.status
    ),
    p_source => p_source
  );

  return jsonb_build_object(
    'absence_id', v_absence.id,
    'status', 'created'
  );
end;
$$;

grant execute on function public.create_workspace_absence(uuid, date, date, text, text, text) to authenticated;

create or replace function public.update_workspace_absence(
  p_absence_id uuid,
  p_starts_on date,
  p_ends_on date,
  p_status text default null,
  p_public_note text default null,
  p_source text default 'calendar_page'
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
set row_security = off
as $$
declare
  v_absence public.workspace_absences;
  v_workspace_id uuid;
  v_role text;
  v_status text;
  v_note text;
begin
  if p_absence_id is null then
    raise exception 'Absence is required';
  end if;

  if p_starts_on is null or p_ends_on is null then
    raise exception 'Start and end dates are required';
  end if;

  if p_starts_on > p_ends_on then
    raise exception 'Start date cannot be after end date';
  end if;

  select *
  into v_absence
  from public.workspace_absences a
  where a.id = p_absence_id
  limit 1;

  if v_absence.id is null then
    raise exception 'Absence not found';
  end if;

  v_workspace_id := v_absence.workspace_id;

  if not public.can_access_workspace(v_workspace_id) then
    raise exception 'No access to this workspace';
  end if;

  v_role := public.resolve_workspace_role(v_workspace_id);

  if v_role not in ('super_admin', 'owner', 'team_lead') and v_absence.profile_id <> auth.uid() then
    raise exception 'You can only edit your own absences';
  end if;

  if p_status is null then
    v_status := v_absence.status;
  else
    v_status := lower(trim(p_status));
    if v_status not in ('planned', 'confirmed', 'cancelled') then
      raise exception 'Invalid status';
    end if;
  end if;

  v_note := case
    when p_public_note is null then v_absence.public_note
    else nullif(trim(p_public_note), '')
  end;

  update public.workspace_absences
  set
    starts_on = p_starts_on,
    ends_on = p_ends_on,
    status = v_status,
    public_note = v_note,
    updated_by = auth.uid(),
    updated_at = now()
  where id = p_absence_id;

  perform public.write_audit_log(
    p_action => 'workspace_absence_updated',
    p_workspace_id => v_workspace_id,
    p_target_type => 'workspace_absence',
    p_target_id => p_absence_id::text,
    p_metadata => jsonb_build_object(
      'absence_id', p_absence_id,
      'starts_on', p_starts_on,
      'ends_on', p_ends_on,
      'status', v_status
    ),
    p_source => p_source
  );

  return jsonb_build_object(
    'absence_id', p_absence_id,
    'status', 'updated'
  );
end;
$$;

grant execute on function public.update_workspace_absence(uuid, date, date, text, text, text) to authenticated;

create or replace function public.delete_workspace_absence(
  p_absence_id uuid,
  p_source text default 'calendar_page'
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
set row_security = off
as $$
declare
  v_absence public.workspace_absences;
  v_role text;
begin
  if p_absence_id is null then
    raise exception 'Absence is required';
  end if;

  select *
  into v_absence
  from public.workspace_absences a
  where a.id = p_absence_id
  limit 1;

  if v_absence.id is null then
    raise exception 'Absence not found';
  end if;

  if not public.can_access_workspace(v_absence.workspace_id) then
    raise exception 'No access to this workspace';
  end if;

  v_role := public.resolve_workspace_role(v_absence.workspace_id);

  if v_role not in ('super_admin', 'owner', 'team_lead') and v_absence.profile_id <> auth.uid() then
    raise exception 'You can only delete your own absences';
  end if;

  delete from public.workspace_absences where id = p_absence_id;

  perform public.write_audit_log(
    p_action => 'workspace_absence_deleted',
    p_workspace_id => v_absence.workspace_id,
    p_target_type => 'workspace_absence',
    p_target_id => p_absence_id::text,
    p_metadata => jsonb_build_object(
      'absence_id', p_absence_id,
      'profile_id', v_absence.profile_id,
      'starts_on', v_absence.starts_on,
      'ends_on', v_absence.ends_on,
      'status', v_absence.status
    ),
    p_source => p_source
  );

  return jsonb_build_object(
    'absence_id', p_absence_id,
    'status', 'deleted'
  );
end;
$$;

grant execute on function public.delete_workspace_absence(uuid, text) to authenticated;

commit;
