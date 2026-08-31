import { execFile } from "node:child_process";
import { access, lstat, readFile, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const AccountIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "use letters, numbers, underscores, or hyphens");

const execFileAsync = promisify(execFile);
let windowsAllowedPrincipalsPromise: Promise<Set<string>> | undefined;

const TlsEndpointSchema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    tls: z.enum(["implicit", "starttls"]),
  })
  .strict();

const FolderNamesSchema = z
  .object({
    inbox: z.string().min(1).default("INBOX"),
    sent: z.string().min(1).optional(),
    drafts: z.string().min(1).optional(),
    archive: z.string().min(1).optional(),
    trash: z.string().min(1).optional(),
    contacts: z.array(z.string().min(1)).max(10).optional(),
  })
  .strict()
  .default({ inbox: "INBOX" });

const AccountPolicySchema = z
  .object({
    allowNewMessages: z.boolean().default(false),
    allowReply: z.boolean().default(false),
    allowReplyAll: z.boolean().default(false),
    allowForward: z.boolean().default(false),
    allowBcc: z.boolean().default(false),
    allowAdditionalReplyRecipients: z.boolean().default(false),
    allowFolderMutations: z.boolean().default(false),
    allowTrash: z.boolean().default(false),
    blockNoReplyAddresses: z.boolean().default(true),
    maxRecipients: z.number().int().min(1).max(100).default(25),
    allowedRecipientDomains: z.array(z.string().min(1)).max(100).optional(),
    blockedRecipientDomains: z.array(z.string().min(1)).max(100).default([]),
  })
  .strict()
  .default({
    allowNewMessages: false,
    allowReply: false,
    allowReplyAll: false,
    allowForward: false,
    allowBcc: false,
    allowAdditionalReplyRecipients: false,
    allowFolderMutations: false,
    allowTrash: false,
    blockNoReplyAddresses: true,
    maxRecipients: 25,
    blockedRecipientDomains: [],
  });

export const AccountConfigSchema = z
  .object({
    id: AccountIdSchema,
    displayName: z.string().min(1).max(100).regex(/^[^\r\n\u0000-\u001f\u007f]+$/u),
    email: z.string().email(),
    aliases: z.array(z.string().email()).max(50).default([]),
    secretRef: z.string().min(1).max(100),
    imap: TlsEndpointSchema,
    smtp: TlsEndpointSchema,
    sentCopyMode: z.enum(["provider", "imap_append", "none"]).default("provider"),
    folders: FolderNamesSchema,
    policy: AccountPolicySchema,
    allowedAttachmentRoots: z.array(z.string().min(1)).max(20).default([]),
  })
  .strict();

const LimitsSchema = z
  .object({
    maxSearchResults: z.number().int().min(1).max(200).default(50),
    maxSearchOffset: z.number().int().min(100).max(100_000).default(5000),
    maxSearchCandidatesPerFolder: z.number().int().min(100).max(100_000).default(5000),
    maxConcurrentConnections: z.number().int().min(1).max(20).default(4),
    maxMessageBytes: z.number().int().min(1024).max(100 * 1024 * 1024).default(15 * 1024 * 1024),
    maxBodyChars: z.number().int().min(1000).max(500_000).default(100_000),
    maxAttachmentBytes: z.number().int().min(1024).max(100 * 1024 * 1024).default(25 * 1024 * 1024),
    maxPreparedDrafts: z.number().int().min(1).max(100).default(20),
    draftTtlSeconds: z.number().int().min(60).max(3600).default(900),
    contactScanMessagesPerFolder: z.number().int().min(10).max(10_000).default(1000),
    contactCacheSeconds: z.number().int().min(10).max(3600).default(300),
  })
  .strict()
  .default({
    maxSearchResults: 50,
    maxSearchOffset: 5000,
    maxSearchCandidatesPerFolder: 5000,
    maxConcurrentConnections: 4,
    maxMessageBytes: 15 * 1024 * 1024,
    maxBodyChars: 100_000,
    maxAttachmentBytes: 25 * 1024 * 1024,
    maxPreparedDrafts: 20,
    draftTtlSeconds: 900,
    contactScanMessagesPerFolder: 1000,
    contactCacheSeconds: 300,
  });

export const AppConfigSchema = z
  .object({
    version: z.literal(1),
    accounts: z.array(AccountConfigSchema).min(1).max(50),
    limits: LimitsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    const addresses = new Set<string>();
    value.accounts.forEach((account, index) => {
      const id = account.id.toLowerCase();
      if (ids.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["accounts", index, "id"],
          message: `duplicate account id: ${account.id}`,
        });
      }
      ids.add(id);

      for (const address of [account.email, ...account.aliases]) {
        const normalized = address.toLowerCase();
        if (addresses.has(normalized)) {
          context.addIssue({
            code: "custom",
            path: ["accounts", index, "aliases"],
            message: `email address or alias is assigned more than once: ${address}`,
          });
        }
        addresses.add(normalized);
      }
    });
  });

const PasswordSecretSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1),
    accessToken: z.never().optional(),
  })
  .strict();

const OAuthSecretSchema = z
  .object({
    username: z.string().min(1),
    accessToken: z.string().min(1),
    password: z.never().optional(),
  })
  .strict();

export const CredentialsFileSchema = z
  .object({
    version: z.literal(1),
    secrets: z.record(z.string(), z.union([PasswordSecretSchema, OAuthSecretSchema])),
  })
  .strict();

export type AccountConfig = z.infer<typeof AccountConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
export type MailSecret = z.infer<typeof PasswordSecretSchema> | z.infer<typeof OAuthSecretSchema>;

export interface LoadedConfig {
  config: AppConfig;
  credentials: Map<string, MailSecret>;
  paths: {
    config: string;
    credentials: string;
  };
}

export interface ConfigPathOptions {
  configPath?: string;
  credentialsPath?: string;
}

export function defaultConfigDirectory(): string {
  if (platform() === "win32") {
    const appData = process.env.APPDATA?.trim();
    return resolve(appData || resolve(homedir(), "AppData", "Roaming"), "CodexEmailMcp");
  }
  return resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "codex-email-mcp");
}

export function resolveConfigPaths(options: ConfigPathOptions = {}): LoadedConfig["paths"] {
  const base = defaultConfigDirectory();
  return {
    config: resolve(options.configPath || process.env.CODEX_EMAIL_CONFIG || resolve(base, "accounts.json")),
    credentials: resolve(
      options.credentialsPath ||
        process.env.CODEX_EMAIL_CREDENTIALS_FILE ||
        resolve(base, "credentials.json"),
    ),
  };
}

async function readJson(path: string, label: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} could not be read at ${path}: ${detail}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON at ${path}: ${detail}`);
  }
}

function formatZodError(label: string, error: z.ZodError): Error {
  const issues = error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
  return new Error(`${label} validation failed: ${issues}`);
}

async function windowsAllowedPrincipals(): Promise<Set<string>> {
  if (!windowsAllowedPrincipalsPromise) {
    windowsAllowedPrincipalsPromise = Promise.all([
      execFileAsync("whoami.exe", [], {
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 32 * 1024,
      }),
      execFileAsync("whoami.exe", ["/user", "/fo", "list"], {
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 32 * 1024,
      }),
    ]).then(([identity, details]) => {
      const currentIdentity = String(identity.stdout).trim().toLowerCase();
      const sid = String(details.stdout).match(/\bS-\d(?:-\d+)+\b/iu)?.[0]?.toLowerCase();
      if (!currentIdentity || !sid) throw new Error("could not determine the current Windows identity and SID");
      return new Set([
        currentIdentity,
        sid,
        "nt authority\\system",
        "system",
        "s-1-5-18",
      ]);
    });
  }
  return windowsAllowedPrincipalsPromise;
}

async function checkSensitiveFileMode(path: string, label: string): Promise<void> {
  if (platform() === "win32") {
    const allowedPrincipals = await windowsAllowedPrincipals();
    await checkWindowsAcl(path, label, allowedPrincipals);
    await checkWindowsAcl(dirname(path), `${label} parent directory`, allowedPrincipals);
    return;
  }
  const details = await lstat(path);
  if (details.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if ((details.mode & 0o077) !== 0) {
    throw new Error(
      `${label} permissions are too broad at ${path}; run chmod 600 and try again`,
    );
  }
  const parent = dirname(path);
  const parentDetails = await lstat(parent);
  if (parentDetails.isSymbolicLink()) throw new Error(`${label} parent must not be a symbolic link: ${parent}`);
  if ((parentDetails.mode & 0o022) !== 0) {
    throw new Error(`${label} parent directory is group- or world-writable: ${parent}`);
  }
}

async function checkWindowsAcl(path: string, label: string, allowedPrincipals: Set<string>): Promise<void> {
  const details = await lstat(path);
  if (details.isSymbolicLink()) {
    throw new Error(`${label} path must not be a symbolic link or junction: ${path}`);
  }
  let stdout: string;
  try {
    const result = await execFileAsync("icacls.exe", [path], {
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 128 * 1024,
    });
    stdout = String(result.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not verify Windows ACL for ${label} path ${path}: ${detail}`);
  }
  validateWindowsAclOutput(path, stdout, allowedPrincipals);
}

export function validateWindowsAclOutput(
  path: string,
  stdout: string,
  allowedPrincipals?: ReadonlySet<string>,
): void {
  const lines = stdout.split(/\r?\n/u);
  const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentLine < 0) {
    throw new Error(`could not parse Windows ACL for credentials path ${path}`);
  }
  const displayedPaths = [path, path.replace(/^\\\\\?\\/u, "")];
  let strippedFirstLine: string | undefined;
  for (const displayedPath of displayedPaths) {
    const line = lines[firstContentLine]!;
    if (line.slice(0, displayedPath.length).toLowerCase() === displayedPath.toLowerCase()) {
      strippedFirstLine = line.slice(displayedPath.length);
      break;
    }
  }
  if (strippedFirstLine === undefined) {
    throw new Error(`could not safely parse Windows ACL output for credentials path ${path}`);
  }
  lines[firstContentLine] = strippedFirstLine;
  const aclLines = lines.filter((line) => line.includes(":("));
  if (aclLines.length === 0) {
    throw new Error(`Windows ACL for credentials path ${path} contains no access entries`);
  }
  const broadPrincipal = /(?:^|\\|\s)(?:Everyone|Users|Authenticated Users|INTERACTIVE|ANONYMOUS LOGON|\u7528\u6237|\u5168\u4f53)(?:\s|:|$)/iu;
  if (aclLines.some((line) => /\(I\)/u.test(line))) {
    throw new Error(`credentials path has inherited Windows permissions; disable inheritance before use: ${path}`);
  }
  if (aclLines.some((line) => broadPrincipal.test(line))) {
    throw new Error(`credentials path is readable by a broad Windows principal; restrict its ACL to the current user and SYSTEM: ${path}`);
  }
  if (allowedPrincipals) {
    const unexpected = aclLines.find((line) => {
      if (/\(DENY\)/iu.test(line)) return false;
      const trimmed = line.trim();
      const marker = trimmed.indexOf(":(");
      if (marker <= 0) return true;
      return !allowedPrincipals.has(trimmed.slice(0, marker).trim().toLowerCase());
    });
    if (unexpected) {
      throw new Error(
        `sensitive path grants access outside the current user and SYSTEM at ${path}: ${unexpected.trim().slice(0, 200)}`,
      );
    }
  }
}

export async function loadConfig(options: ConfigPathOptions = {}): Promise<LoadedConfig> {
  const paths = resolveConfigPaths(options);
  await checkSensitiveFileMode(paths.config, "accounts config");
  const configResult = AppConfigSchema.safeParse(await readJson(paths.config, "accounts config"));
  if (!configResult.success) throw formatZodError("accounts config", configResult.error);

  const credentials = new Map<string, MailSecret>();
  let credentialsFilePresent = true;
  try {
    await access(paths.credentials);
  } catch {
    credentialsFilePresent = false;
  }
  if (credentialsFilePresent) {
    await checkSensitiveFileMode(paths.credentials, "credentials file");
    const credentialsResult = CredentialsFileSchema.safeParse(
      await readJson(paths.credentials, "credentials file"),
    );
    if (!credentialsResult.success) throw formatZodError("credentials file", credentialsResult.error);
    for (const [name, secret] of Object.entries(credentialsResult.data.secrets)) credentials.set(name, secret);
  }

  for (const account of configResult.data.accounts) {
    if (!credentials.has(account.secretRef)) {
      const raw = process.env[account.secretRef];
      if (raw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          throw new Error(`environment secret ${account.secretRef} is not valid JSON`);
        }
        const result = z.union([PasswordSecretSchema, OAuthSecretSchema]).safeParse(parsed);
        if (!result.success) throw formatZodError(`environment secret ${account.secretRef}`, result.error);
        credentials.set(account.secretRef, result.data);
      }
    }
    if (!credentials.has(account.secretRef)) {
      throw new Error(
        `no secret named ${JSON.stringify(account.secretRef)} was found for account ${account.id}; add it to the credentials file or process environment`,
      );
    }
  }

  return { config: configResult.data, credentials, paths };
}

export function configParentDirectories(paths: LoadedConfig["paths"]): string[] {
  return [dirname(paths.config), dirname(paths.credentials)];
}
