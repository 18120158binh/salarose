import "server-only";
import { randomUUID } from "node:crypto";
import { Kafka, logLevel, type Admin } from "kafkajs";
import { createDeadLetterReader, DeadLetterReadError, type DeadLetterReader } from "./deadLetterReader";
import { parseDeadLetterConfig, type DeadLetterConfig } from "./deadLetters";

const notConfigured: DeadLetterReader = {
  droppedCount: () => Promise.reject(new DeadLetterReadError("not configured")),
  readPage: () => Promise.reject(new DeadLetterReadError("not configured")),
  readContent: () => Promise.reject(new DeadLetterReadError("not configured")),
  retention: () => Promise.resolve({ kind: "unknown" }),
};

function kafkaReader(config: DeadLetterConfig): DeadLetterReader {
  const kafka = new Kafka({
    clientId: "studio-dead-letters",
    brokers: config.brokers,
    ssl: config.ssl,
    sasl: config.sasl,
    logLevel: logLevel.WARN,
    connectionTimeout: 3_000,
    // A missing topic or a down broker should fail a page in seconds, not after kafkajs's default backoff.
    retry: { retries: 2, initialRetryTime: 100, maxRetryTime: 1_000 },
  });
  let admin: Promise<Admin> | null = null;
  const connectedAdmin = () => {
    if (!admin) {
      const created = kafka.admin();
      const pending = created.connect().then(() => created);
      pending.catch(() => {
        if (admin === pending) admin = null;
      });
      admin = pending;
    }
    return admin;
  };
  return createDeadLetterReader({
    topic: config.topic,
    groupPrefix: config.groupPrefix,
    admin: connectedAdmin,
    consumer: (groupId) =>
      kafka.consumer({
        groupId,
        allowAutoTopicCreation: false,
        // The ranges a read asks for already exist, so a fetch need not wait for new records.
        maxWaitTimeInMs: 100,
        // A crashed read fails its request. kafkajs must not rejoin the group behind it.
        retry: { retries: 1, restartOnFailure: async () => false },
      }),
    groupSuffix: randomUUID,
    now: Date.now,
  });
}

let reader: DeadLetterReader | null = null;

// The process's one reader of the dead-letter topic. Rejects every read with "not configured" when
// DEAD_LETTER_KAFKA_BROKERS is unset or a setting is invalid.
export function deadLetterReader(): DeadLetterReader {
  if (!reader) {
    let config: DeadLetterConfig | null = null;
    try {
      config = parseDeadLetterConfig(process.env);
    } catch (error) {
      console.warn(`[dead-letters] ${error instanceof Error ? error.message : "Invalid configuration."}`);
    }
    reader = config ? kafkaReader(config) : notConfigured;
  }
  return reader;
}
