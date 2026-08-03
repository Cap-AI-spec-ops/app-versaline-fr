-- Add language + locale to daily briefing preferences

begin;

alter table if exists public.daily_briefing_preferences
add column if not exists language text,
add column if not exists locale text;

update public.daily_briefing_preferences p
set
  language = coalesce(nullif(trim(p.language), ''), nullif(trim(w.default_language), ''), 'en'),
  locale = coalesce(nullif(trim(p.locale), ''), nullif(trim(w.default_locale), ''), 'en-US')
from public.workspaces w
where w.id = p.workspace_id;

alter table if exists public.daily_briefing_preferences
alter column language set default 'en',
alter column locale set default 'en-US';

alter table if exists public.daily_briefing_preferences
alter column language set not null,
alter column locale set not null;

do $$
begin
  alter table public.daily_briefing_preferences
  add constraint daily_briefing_preferences_language_check
  check (language ~ '^[a-z]{2}$');
exception when others then
  null;
end $$;

do $$
begin
  alter table public.daily_briefing_preferences
  add constraint daily_briefing_preferences_locale_check
  check (locale ~ '^[a-z]{2}-[A-Z]{2}$');
exception when others then
  null;
end $$;

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

  new.language := lower(coalesce(nullif(trim(new.language), ''), nullif(trim(v_workspace.default_language), ''), 'en'));
  new.locale := coalesce(nullif(trim(new.locale), ''), nullif(trim(v_workspace.default_locale), ''), 'en-US');

  if new.language !~ '^[a-z]{2}$' then
    raise exception 'Invalid language format';
  end if;

  if new.locale !~ '^[a-z]{2}-[A-Z]{2}$' then
    raise exception 'Invalid locale format';
  end if;

  return new;
end;
$$;

commit;
