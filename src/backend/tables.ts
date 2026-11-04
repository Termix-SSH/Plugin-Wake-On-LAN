import {
  boolean,
  defineTable,
  integer,
  id,
  refHost,
  text,
  timestamp,
  varchar,
} from "@termix-ssh/plugin-sdk/db";

/**
 * Power settings and last known state, one row per host. Commands and
 * passwords live here, sealed, and never in host settings: anyone with edit
 * access to a host can change its settings.
 */
export const devices = defineTable(
  "devices",
  {
    id: id(),
    hostId: refHost(),
    lanIp: varchar(64).notNull().default(""),
    netmask: varchar(64).notNull().default(""),
    description: text(),
    linkUrl: text(),
    autoOpenLink: boolean().notNull().default(false),

    wakeFrom: integer(),
    wakePort: integer().notNull().default(9),
    wakeMode: varchar(12).notNull().default("magic"),
    wakeCommandSealed: text(),
    wakeTimeout: integer().notNull().default(120),
    wakeConfirm: boolean().notNull().default(false),
    wakeCron: varchar(120).notNull().default(""),
    secureOnSealed: text(),

    statusFrom: integer(),
    ports: varchar(255).notNull().default(""),
    pingCommandSealed: text(),

    shutdownMode: varchar(12).notNull().default("none"),
    shutdownCommandSealed: text(),
    shutdownTimeout: integer().notNull().default(120),
    shutdownConfirm: boolean().notNull().default(true),
    shutdownCron: varchar(120).notNull().default(""),

    commandTarget: varchar(12).notNull().default("host"),
    commandRelay: integer(),

    solEnabled: boolean().notNull().default(false),
    solPort: integer().notNull().default(8009),
    solUser: varchar(120).notNull().default(""),
    solPasswordSealed: text(),

    status: varchar(12).notNull().default("unknown"),
    openPorts: varchar(255).notNull().default(""),
    statusChangedAt: timestamp(),
    lastSeenAt: timestamp(),
    lastWakeRunAt: timestamp(),
    lastShutdownRunAt: timestamp(),
    updatedBy: varchar(255),
  },
  {
    uniques: [{ name: "idx_p_wake_on_lan_devices_host", columns: ["hostId"] }],
  },
);

// termix-plugin migrations reads this list.
export const tables = [devices];
