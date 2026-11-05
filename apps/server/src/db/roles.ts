import { randomBytes, pbkdf2Sync, createHmac, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type pg from 'pg';

const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const appPermissions = new Map<string, string>([
  ...[
    'visitors',
    'sessions',
    'events',
    'page_views',
    'visitor_days',
    'ip_days',
    'distinct_hours',
    'dirty_buckets',
    'sites',
    'site_data_coverage',
  ].map((name) => [name, 'INSERT,UPDATE'] as [string, string]),
  ...['deletion_jobs', 'deletion_outbox', 'coverage_gaps', 'site_rules'].map(
    (name) => [name, 'INSERT'] as [string, string],
  ),
  ['admin_sessions', 'INSERT,UPDATE,DELETE'],
]);
function verifier(password: string) {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const stored = createHash('sha256').update(clientKey).digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}
export async function prepareRoles(client: pg.PoolClient, env = process.env) {
  const context = (
    await client.query(
      'SELECT current_schema() AS schema,current_database() AS db,current_user AS owner',
    )
  ).rows[0];
  const schema = identifier(context.schema);
  const roles = [
    {
      name: env.DB_APP_USER ?? 'webpulse_app',
      file: env.DB_APP_PASSWORD_FILE!,
      maintenance: false,
    },
    {
      name: env.DB_WORKER_USER ?? 'webpulse_worker',
      file: env.DB_WORKER_PASSWORD_FILE!,
      maintenance: true,
    },
  ];
  if (new Set([context.owner, ...roles.map((r) => r.name)]).size !== 3)
    throw new Error('Independent roles required');
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(1464878405,2)');
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON DATABASE ${identifier(context.db)} FROM PUBLIC`);
    for (const role of roles) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(role.name)) throw new Error('Invalid role');
      const password = readFileSync(role.file, 'utf8').trim();
      if (password.length < 32) throw new Error('Strong role password required');
      const existing = (
        await client.query(
          'SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',
          [role.name],
        )
      ).rows[0];
      if (existing && Object.values(existing).some(Boolean))
        throw new Error('Unsafe existing runtime role');
      const membership = (
        await client.query(
          'SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1 LIMIT 1',
          [role.name],
        )
      ).rowCount;
      if (membership) throw new Error('Runtime role has memberships');
      const owns = (
        await client.query(
          'SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname=$1 UNION ALL SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE r.rolname=$1 LIMIT 1',
          [role.name],
        )
      ).rowCount;
      if (owns) throw new Error('Runtime role must not own database objects');
      const name = identifier(role.name);
      if (!existing)
        await client.query(
          `CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
        );
      // Only a SCRAM verifier reaches SQL; plaintext passwords never enter statements/logs.
      await client.query(`ALTER ROLE ${name} PASSWORD '${verifier(password)}'`);
      await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${name}`);
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${name}`);
      await client.query(`GRANT CONNECT ON DATABASE ${identifier(context.db)} TO ${name}`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${name}`);
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${name}`);
      const tables = (
        await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [context.schema])
      ).rows
        .map((r) => r.tablename as string)
        .filter((t) =>
          role.maintenance
            ? t !== 'schema_migrations'
            : ![
                'admins',
                'schema_migrations',
                'backup_inventory',
                'recovery_state',
                'recovery_replays',
                'deletion_rebuild_buckets',
              ].includes(t),
        );
      for (const table of tables) {
        const permissions = role.maintenance ? 'INSERT,UPDATE,DELETE' : appPermissions.get(table);
        if (permissions)
          await client.query(`GRANT ${permissions} ON ${schema}.${identifier(table)} TO ${name}`);
      }
      if (!role.maintenance)
        await client.query(
          `REVOKE ALL ON ${schema}.backup_inventory,${schema}.recovery_replays FROM ${name}`,
        );
      await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${name}`);
      await client.query(`ALTER ROLE ${name} SET search_path TO ${schema},pg_catalog`);
      await client.query(`ALTER ROLE ${name} SET idle_in_transaction_session_timeout='5s'`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
