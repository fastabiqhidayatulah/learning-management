export const DEMO_EMAIL = 'demo.user@zite.com';

/** The id of a stand-in that exists only in memory; every id-scoped query simply finds nothing for it. */
export const DEMO_ID = '00000000-0000-0000-0000-000000000000';

/** The marketplace demo: read-only database, synthetic visitor. Never true for an installed app. */
export const isDemo = (context?: { user?: { email?: string | null } | null }) =>
  /\/\/zite-demo-/.test(process.env.ZITE_APP_URL ?? '') ||
  (context?.user?.email ?? '').trim().toLowerCase() === DEMO_EMAIL;
