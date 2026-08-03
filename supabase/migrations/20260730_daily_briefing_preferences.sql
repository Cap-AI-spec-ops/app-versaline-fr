-- Daily briefing preferences (per user) + run log for idempotent daily sends

begin;

create table if not exists public.daily_briefing_preferences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  is_enabled boolean not null default false,
  send_weekdays smallint[] not null default array[1, 2, 3, 4, 5]::smallint[],
  send_time_local time not null default time '08:30:00',
  timezone text,
  include_workspace_snapshot boolean not null default true,
  include_email_delivery boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_briefing_preferences_user_unique unique (workspace_id, profile_id),
  constraint daily_briefing_preferences_weekdays_not_empty check (cardinality(send_weekdays) between 1 and 7),
  constraint daily_briefing_preferences_timezone_not_empty check (timezone is null or length(trim(timezone)) > 0)
);

create index if not exists daily_briefing_preferences_profile_idx
  on public.daily_briefing_preferences (profile_id, updated_at desc);

create index if not exists daily_briefing_preferences_schedule_idx
  on public.daily_briefing_preferences (is_enabled, send_time_local);

create table if not exists public.daily_briefing_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  preference_id uuid references public.daily_briefing_preferences(id) on delete set null,
  scheduled_for_local_date date not null,
  scheduled_weekday smallint not null,
  scheduled_send_time_local time not null,
  scheduled_timezone text not null,
  status text not null default 'pending',
  dedupe_key text,
  run_started_at timestamptz not null default now(),
  sent_at timestamptz,
  failure_code text,
  failure_message text,
  payload_metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_briefing_runs_unique_day unique (workspace_id, profile_id, scheduled_for_local_date),
  constraint daily_briefing_runs_weekday_check check (scheduled_weekday between 0 and 6),
  constraint daily_briefing_runs_status_check check (status in ('pending', 'sent', 'skipped', 'failed')),
  constraint daily_briefing_runs_timezone_not_empty check (length(trim(scheduled_timezone)) > 0),
  constraint daily_briefing_runs_failure_message_length check (failure_message is null or char_length(failure_message) <= 1200)
);

create unique index if not exists daily_briefing_runs_dedupe_key_unique_idx
  on public.daily_briefing_runs (dedupe_key)
  where dedupe_key is not null;

create index if not exists daily_briefing_runs_workspace_date_idx
  on public.daily_briefing_runs (workspace_id, scheduled_for_local_date desc);

create index if not exists daily_briefing_runs_profile_date_idx
  on public.daily_briefing_runs (profile_id, scheduled_for_local_date desc);

create index if not exists daily_briefing_runs_status_idx
  on public.daily_briefing_runs (status, run_started_at desc);

create or replace function public.set_updated_at_daily_briefing_preferences()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_daily_briefing_preferences on public.daily_briefing_preferences;
create trigger trg_set_updated_at_daily_briefing_preferences
before update on public.daily_briefing_preferences
for each row
execute function public.set_updated_at_daily_briefing_preferences();

create or replace function public.set_updated_at_daily_briefing_runs()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_daily_briefing_runs on public.daily_briefing_runs;
create trigger trg_set_updated_at_daily_briefing_runs
before update on public.daily_briefing_runs
for each row
execute function public.set_updated_at_daily_briefing_runs();

create or replace function public.daily_briefing_preferences_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor_id uuid := auth.uid();
  v_profile public.profiles;
  v_workspace public.workspaces;
  v_normalized_weekdays smallint[];
begin
  if v_actor_id is null then
    if new.profile_id is null then
      raise exception 'Profile is required';
    end if;

    if new.workspace_id is null then
      raise exception 'Workspace is required';
    end if;
  else
    select *
    into v_profile
    from public.profiles p
    where p.id = v_actor_id
    limit 1;

    if v_profile.id is null then
      raise exception 'Profile not found';
    end if;

    if new.profile_id is null then
      new.profile_id := v_profile.id;
    end if;

    if new.profile_id <> v_profile.id then
      raise exception 'You can only modify your own daily briefing preferences';
    end if;

    if new.workspace_id is null then
      new.workspace_id := v_profile.workspace_id;
    end if;

    if new.workspace_id is null then
      raise exception 'No active workspace on profile';
    end if;

    if not public.can_access_workspace(new.workspace_id) then
      raise exception 'Workspace access denied';
    end if;
  end if;

  select *
  into v_workspace
  from public.workspaces w
  where w.id = new.workspace_id
  limit 1;

  if v_workspace.id is null then
    raise exception 'Workspace not found';
  end if;

  select coalesce(array_agg(distinct d order by d), array[]::smallint[])
  into v_normalized_weekdays
  from unnest(coalesce(new.send_weekdays, array[]::smallint[])) as d;

  if cardinality(v_normalized_weekdays) = 0 then
    v_normalized_weekdays := array[1, 2, 3, 4, 5]::smallint[];
  end if;

  if exists (
    select 1
    from unnest(v_normalized_weekdays) as d
    where d < 0 or d > 6
  ) then
    raise exception 'Weekdays must contain values from 0 to 6';
  end if;

  new.send_weekdays := v_normalized_weekdays;

  if new.timezone is not null and length(trim(new.timezone)) = 0 then
    new.timezone := null;
  end if;

  if new.timezone is null then
    new.timezone := coalesce(nullif(trim(v_workspace.default_timezone), ''), 'Europe/Paris');
  else
    new.timezone := trim(new.timezone);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_daily_briefing_preferences_defaults on public.daily_briefing_preferences;
create trigger trg_daily_briefing_preferences_defaults
before insert or update on public.daily_briefing_preferences
for each row
execute function public.daily_briefing_preferences_defaults();

alter table public.daily_briefing_preferences enable row level security;
alter table public.daily_briefing_runs enable row level security;

drop policy if exists "daily_briefing_preferences_select" on public.daily_briefing_preferences;
create policy "daily_briefing_preferences_select"
on public.daily_briefing_preferences
for select
to authenticated
using (
  profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
);

drop policy if exists "daily_briefing_preferences_insert" on public.daily_briefing_preferences;
create policy "daily_briefing_preferences_insert"
on public.daily_briefing_preferences
for insert
to authenticated
with check (
  profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
);

drop policy if exists "daily_briefing_preferences_update" on public.daily_briefing_preferences;
create policy "daily_briefing_preferences_update"
on public.daily_briefing_preferences
for update
to authenticated
using (
  profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
)
with check (
  profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
);

drop policy if exists "daily_briefing_preferences_delete" on public.daily_briefing_preferences;
create policy "daily_briefing_preferences_delete"
on public.daily_briefing_preferences
for delete
to authenticated
using (
  profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
);

drop policy if exists "daily_briefing_runs_select" on public.daily_briefing_runs;
create policy "daily_briefing_runs_select"
on public.daily_briefing_runs
for select
to authenticated
using (
  profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
);

grant select, insert, update, delete on table public.daily_briefing_preferences to authenticated;
grant select on table public.daily_briefing_runs to authenticated;

commit;
