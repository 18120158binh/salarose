-- Runs before every migrate, including one with nothing pending. The apps connect as the role that
-- runs Flyway, and only an owner can alter a table, so every object in public must belong to it.
-- An object another role created, such as DDL applied by hand as postgres, fails the run and is
-- named. Objects the migrations create belong to this role, because it runs them. Members of an
-- extension belong to whoever created the extension, so they are skipped.
DO $$
DECLARE
    strays text;
BEGIN
    SELECT string_agg(format('%s %s (owner %s)', kind, name, owner), ', ' ORDER BY kind, name)
    INTO strays
    FROM (
        SELECT CASE c.relkind WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END AS kind,
               c.oid::regclass::text AS name,
               pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
          AND c.relowner <> current_user::text::regrole
        UNION ALL
        SELECT 'function', p.oid::regprocedure::text, pg_get_userbyid(p.proowner)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proowner <> current_user::text::regrole
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
        UNION ALL
        SELECT 'publication', p.pubname::text, pg_get_userbyid(p.pubowner)
        FROM pg_publication p
        WHERE p.pubowner <> current_user::text::regrole
    ) AS stray;
    IF strays IS NOT NULL THEN
        RAISE EXCEPTION 'objects not owned by %: %', current_user, strays
            USING HINT = 'As a superuser, run ALTER ... OWNER TO ' || current_user || ' on each, then sync again.';
    END IF;
END $$;
