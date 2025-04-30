import {
  pgTable,
  text,
  timestamp,
  jsonb,
  serial,
  bigint,
  smallint,
  varchar,
  date,
  primaryKey,
  index,
  check,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Custom type for TEXT[]
const textArray = customType<{ data: string[] }>({
  dataType() {
    return 'text[]';
  },
});

export const sites = pgTable(
  'sites',
  {
    siteId: text('site_id').primaryKey(), // ULIDs are strings
    ownerSub: text('owner_sub').notNull(),
    name: text('name').notNull(),
    domains: textArray('domains').notNull(),
    plan: text('plan').notNull().default('free_tier'),
    requestAllowance: bigint('request_allowance', { mode: 'number' }).notNull().default(10000),
    complianceLevel: smallint('compliance_level').notNull().default(1).$type<0 | 1 | 2>(), // 0=yes, 1=maybe, 2=no
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Optional: stripe_subscription_id: text('stripe_subscription_id'),
  },
  (table) => ({
    ownerSubIdx: index('sites_owner_sub_idx').on(table.ownerSub),
    planIdx: index('sites_plan_idx').on(table.plan),
    complianceCheck: check('compliance_level_check', sql`${table.complianceLevel} IN (0, 1, 2)`),
  })
);

export const accounts = pgTable(
  'accounts',
  {
    cognitoSub: text('cognito_sub').primaryKey(),
    emailNotifications: text('email_notifications').notNull().default('daily'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Optional: stripe_customer_id: text('stripe_customer_id'),
  }
);

export const events = pgTable(
  'events',
  {
    eventId: serial('event_id').primaryKey(),
    siteId: text('site_id').notNull(),
    sessionId: text('session_id').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    dt: date('dt').notNull(), // Partitioning key
    event: text('event').notNull(),
    pathname: text('pathname').notNull(),
    properties: jsonb('properties'),
  },
  (table) => ({
    siteIdIdx: index('events_site_id_idx').on(table.siteId),
    sessionIdIdx: index('events_session_id_idx').on(table.sessionId),
    timestampIdx: index('events_timestamp_idx').on(table.timestamp),
    dtIdx: index('events_dt_idx').on(table.dt),
    // Composite indexes as considered in the plan
    siteTimestampIdx: index('events_site_timestamp_idx').on(table.siteId, table.timestamp),
    sessionTimestampIdx: index('events_session_timestamp_idx').on(table.sessionId, table.timestamp),
  })
);

export const initialEvents = pgTable(
  'initial_events',
  {
    eventId: serial('event_id').primaryKey(),
    siteId: text('site_id').notNull(),
    sessionId: text('session_id').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    dt: date('dt').notNull(), // Partitioning key
    event: text('event').notNull(),
    pathname: text('pathname').notNull(),
    properties: jsonb('properties'),
    referer: text('referer'),
    refererDomain: text('referer_domain'),
    utmSource: varchar('utm_source', { length: 255 }),
    utmMedium: varchar('utm_medium', { length: 255 }),
    utmCampaign: varchar('utm_campaign', { length: 255 }),
    utmContent: varchar('utm_content', { length: 255 }),
    utmTerm: varchar('utm_term', { length: 255 }),
    device: varchar('device', { length: 100 }),
    os: varchar('os', { length: 100 }),
    browser: varchar('browser', { length: 100 }),
    country: varchar('country', { length: 100 }),
    region: varchar('region', { length: 100 }),
    city: varchar('city', { length: 100 }),
    screenWidth: smallint('screen_width'),
    screenHeight: smallint('screen_height'),
  },
  (table) => ({
    siteIdIdx: index('initial_events_site_id_idx').on(table.siteId),
    sessionIdIdx: index('initial_events_session_id_idx').on(table.sessionId),
    timestampIdx: index('initial_events_timestamp_idx').on(table.timestamp),
    dtIdx: index('initial_events_dt_idx').on(table.dt),
    // Composite indexes as considered in the plan
    siteTimestampIdx: index('initial_events_site_timestamp_idx').on(table.siteId, table.timestamp),
    sessionTimestampIdx: index('initial_events_session_timestamp_idx').on(table.sessionId, table.timestamp),
  })
);