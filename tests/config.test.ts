import { describe, expect, it } from "vitest";
import { validateWindowsAclOutput } from "../src/config.js";

const path = String.raw`C:\Users\Jeffery\AppData\Roaming\CodexEmailMcp\credentials.json`;
const allowed = new Set([
  "jeffery-pc\\jeffery",
  "nt authority\\system",
  "s-1-5-18",
]);

describe("Windows credential ACL parsing", () => {
  it("checks the first ACE printed on the same line as the path", () => {
    const output = [
      `${path} BUILTIN\\Users:(RX)`,
      "              NT AUTHORITY\\SYSTEM:(F)",
      "Successfully processed 1 files; Failed processing 0 files",
    ].join("\r\n");

    expect(() => validateWindowsAclOutput(path, output)).toThrow(/broad Windows principal/i);
  });

  it("rejects inherited access even when the principals are otherwise narrow", () => {
    const output = [
      `${path} JEFFERY-PC\\Jeffery:(I)(F)`,
      "              NT AUTHORITY\\SYSTEM:(I)(F)",
      "Successfully processed 1 files; Failed processing 0 files",
    ].join("\r\n");

    expect(() => validateWindowsAclOutput(path, output)).toThrow(/inherited Windows permissions/i);
  });

  it("accepts explicit ACLs limited to a user and SYSTEM", () => {
    const output = [
      `${path} JEFFERY-PC\\Jeffery:(F)`,
      "              NT AUTHORITY\\SYSTEM:(F)",
      "Successfully processed 1 files; Failed processing 0 files",
    ].join("\r\n");

    expect(() => validateWindowsAclOutput(path, output, allowed)).not.toThrow();
  });

  it("rejects an explicit grant to another local account or custom group", () => {
    const output = [
      `${path} JEFFERY-PC\\Jeffery:(F)`,
      "              JEFFERY-PC\\MailReaders:(R)",
      "              NT AUTHORITY\\SYSTEM:(F)",
      "Successfully processed 1 files; Failed processing 0 files",
    ].join("\r\n");

    expect(() => validateWindowsAclOutput(path, output, allowed)).toThrow(
      /outside the current user and SYSTEM/i,
    );
  });
});
