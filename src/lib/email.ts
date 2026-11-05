/**
 * Minimal dependency-free email sender: SMTP over implicit TLS (port 465)
 * with AUTH PLAIN -- enough to send a plain-text alert from your own Gmail
 * account to yourself using a Gmail App Password. Deliberately no npm
 * dependency: this job also holds your tmwork password, so every extra
 * package is extra supply-chain risk.
 */

import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import tls from "node:tls";

export interface EmailOptions {
  user: string; // SMTP login, also used as the From address
  password: string; // Gmail App Password (not your normal password)
  to: string;
  subject: string;
  body: string;
  urgent?: boolean; // sets X-Priority/Importance: high
  host?: string;
  port?: number;
  /** Override for tests (e.g. a plain TCP socket to a fake server). */
  connect?: () => Duplex;
}

/** RFC 2047 encoded-word so emoji/arrows survive in the Subject header. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function buildMessage(o: EmailOptions): string {
  const body64 = Buffer.from(o.body, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
  const headers = [
    `From: tmwork-schedule-sync <${o.user}>`,
    `To: <${o.to}>`,
    `Subject: ${encodeHeader(o.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@tmwork-schedule-sync>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    ...(o.urgent ? ["X-Priority: 1", "Importance: high"] : []),
  ];
  // base64 lines never start with ".", so no dot-stuffing is needed.
  return headers.join("\r\n") + "\r\n\r\n" + body64;
}

export async function sendEmail(o: EmailOptions): Promise<void> {
  const socket =
    o.connect?.() ?? tls.connect({ host: o.host ?? "smtp.gmail.com", port: o.port ?? 465, servername: o.host ?? "smtp.gmail.com" });

  // Collects server replies; a reply is complete at a line like "250 ..."
  // (multi-line replies use "250-..." for all but the last line).
  let buffer = "";
  const waiting: Array<{ resolve: (r: string) => void; reject: (e: Error) => void }> = [];
  const replies: string[] = [];
  let failure: Error | null = null;

  const flush = () => {
    while (replies.length && waiting.length) waiting.shift()!.resolve(replies.shift()!);
  };
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let lines: string[] = [];
    let idx: number;
    while ((idx = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        replies.push(lines.join("\n"));
        lines = [];
      }
    }
    if (lines.length) buffer = lines.join("\r\n") + "\r\n" + buffer;
    flush();
  });
  const fail = (err: Error) => {
    failure ??= err;
    while (waiting.length) waiting.shift()!.reject(failure);
  };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("SMTP connection closed unexpectedly")));

  const next = (): Promise<string> =>
    failure
      ? Promise.reject(failure)
      : new Promise((resolve, reject) => {
          waiting.push({ resolve, reject });
          flush();
        });

  const expect = async (code: string, what: string) => {
    const reply = await next();
    if (!reply.startsWith(code)) {
      // Never include the message itself in errors -- logs are public.
      throw new Error(`SMTP ${what} failed: ${reply.split("\n").pop()}`);
    }
  };
  const send = (line: string) => socket.write(line + "\r\n");

  const timer = setTimeout(() => {
    fail(new Error("SMTP timed out"));
    socket.destroy();
  }, 30_000);

  try {
    await expect("220", "greeting");
    send("EHLO tmwork-schedule-sync");
    await expect("250", "EHLO");
    send("AUTH PLAIN " + Buffer.from(`\0${o.user}\0${o.password}`, "utf8").toString("base64"));
    await expect("235", "login (check GMAIL_USER / GMAIL_APP_PASSWORD)");
    send(`MAIL FROM:<${o.user}>`);
    await expect("250", "MAIL FROM");
    send(`RCPT TO:<${o.to}>`);
    await expect("250", "RCPT TO");
    send("DATA");
    await expect("354", "DATA");
    socket.write(buildMessage(o) + "\r\n.\r\n");
    await expect("250", "message send");
    send("QUIT");
  } finally {
    clearTimeout(timer);
    socket.removeAllListeners("close");
    socket.end();
  }
}
