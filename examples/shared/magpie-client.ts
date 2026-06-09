import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";

export interface AgentConfig {
  baseUrl: string;
  wallet: string;
  paymentSignature?: string;
}

export interface PaidChallenge {
  status: 402;
  scheme: string | null;
  amountLamports: string | null;
  recipient: string | null;
  nonce: string | null;
  memo: string | null;
  body: unknown;
}

export type PaidResult<T> =
  | { kind: "challenge"; challenge: PaidChallenge }
  | { kind: "response"; data: T; status: number };

const examplesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile() {
  const envPath = resolve(examplesRoot, ".env");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

export function integerEnv(name: string, fallback: number): number {
  const parsed = numberEnv(name, fallback);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

export function loadConfig(): AgentConfig {
  loadEnvFile();
  const baseUrl = env("MAGPIE_X402_BASE_URL", "http://localhost:8402").replace(/\/+$/, "");
  const wallet = env("MAGPIE_WALLET", "9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump");
  new PublicKey(wallet);
  const paymentSignature = process.env.X402_PAYMENT_SIGNATURE?.trim() || undefined;
  return { baseUrl, wallet, paymentSignature };
}

export function pubkeyEnv(name: string, fallback: string): string {
  const value = env(name, fallback);
  new PublicKey(value);
  return value;
}

export function rawAmountEnv(name: string, fallback: string): string {
  const value = env(name, fallback);
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an unsigned integer string`);
  return value;
}

export async function getJson<T>(config: AgentConfig, path: string): Promise<T> {
  const response = await fetch(`${config.baseUrl}${path}`);
  const body = await parseJson(response);
  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${response.status}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

export async function paidJson<T>(
  config: AgentConfig,
  path: string,
  init: RequestInit = {},
): Promise<PaidResult<T>> {
  const first = await fetch(`${config.baseUrl}${path}`, init);
  const body = await parseJson(first);
  if (first.status !== 402) {
    if (!first.ok) {
      throw new Error(`${init.method ?? "GET"} ${path} failed with ${first.status}: ${JSON.stringify(body)}`);
    }
    return { kind: "response", status: first.status, data: body as T };
  }

  const challenge: PaidChallenge = {
    status: 402,
    scheme: first.headers.get("x-payment-required-scheme"),
    amountLamports: first.headers.get("x-payment-required-amount"),
    recipient: first.headers.get("x-payment-required-recipient"),
    nonce: first.headers.get("x-payment-required-nonce"),
    memo: first.headers.get("x-payment-required-memo"),
    body,
  };
  printChallenge(path, challenge);

  if (!config.paymentSignature) return { kind: "challenge", challenge };

  const headers = new Headers(init.headers);
  headers.set("X-Payment", config.paymentSignature);
  const retry = await fetch(`${config.baseUrl}${path}`, { ...init, headers });
  const retryBody = await parseJson(retry);
  if (!retry.ok) {
    throw new Error(`paid retry for ${path} failed with ${retry.status}: ${JSON.stringify(retryBody)}`);
  }
  return { kind: "response", status: retry.status, data: retryBody as T };
}

export function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function printJson(label: string, value: unknown) {
  console.log(`${label}:`);
  console.log(JSON.stringify(value, null, 2));
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function printChallenge(path: string, challenge: PaidChallenge) {
  console.log(`x402 challenge for ${path}`);
  console.log(`  scheme: ${challenge.scheme ?? "missing"}`);
  console.log(`  amount lamports: ${challenge.amountLamports ?? "missing"}`);
  console.log(`  recipient: ${challenge.recipient ?? "missing"}`);
  console.log(`  nonce: ${challenge.nonce ?? "missing"}`);
  console.log(`  memo: ${challenge.memo ?? "missing"}`);
  console.log("  Send the payment with that memo, then re-run with X402_PAYMENT_SIGNATURE set.");
}
