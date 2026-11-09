import type { SASLOptions } from "kafkajs";

export interface KafkaConnection {
  brokers: string[];
  ssl: boolean;
  sasl?: SASLOptions;
}

export type Env = Record<string, string | undefined>;

// Reads <PREFIX>_KAFKA_BROKERS, _SSL, _SASL_MECHANISM, _SASL_USERNAME, and _SASL_PASSWORD. Null when
// the brokers are unset. Throws on a setting that is present but invalid.
export function parseKafkaConnection(env: Env, prefix: string): KafkaConnection | null {
  const brokers = (env[`${prefix}_KAFKA_BROKERS`] ?? "").split(",").map((b) => b.trim()).filter(Boolean);
  if (brokers.length === 0) return null;
  const ssl = (env[`${prefix}_KAFKA_SSL`]?.trim() ?? "").toLowerCase() === "true";
  const mechanism = env[`${prefix}_KAFKA_SASL_MECHANISM`]?.trim().toLowerCase();
  if (!mechanism) return { brokers, ssl };
  if (mechanism !== "plain" && mechanism !== "scram-sha-256" && mechanism !== "scram-sha-512") {
    throw new Error(`${prefix}_KAFKA_SASL_MECHANISM must be plain, scram-sha-256, or scram-sha-512.`);
  }
  const username = env[`${prefix}_KAFKA_SASL_USERNAME`] ?? "";
  const password = env[`${prefix}_KAFKA_SASL_PASSWORD`] ?? "";
  if (!username || !password) {
    throw new Error(`${prefix}_KAFKA_SASL_USERNAME and ${prefix}_KAFKA_SASL_PASSWORD are required with SASL.`);
  }
  return { brokers, ssl, sasl: { mechanism, username, password } };
}
