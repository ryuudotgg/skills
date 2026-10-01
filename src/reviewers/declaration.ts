import { accessSync, constants, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Setting = {
  name: string;
  key: string;
  defaultValue: string;
  pattern: string;
};

export type Declaration = {
  name: string;
  displayName: string;
  logins: string[];
  handles: string[];
  trigger: string;
  check: string;
  outsideDiff?: string;
  settings: Setting[];
};

export const reviewerName = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function matchesSetting(source: string, value: string): boolean {
  const match = new RegExp(`^(?:${source})$`).exec(value);
  return match !== null && match[0] === value;
}

export function readDeclarations(root: string): Declaration[] {
  const declarations: Declaration[] = [];
  const claims = new Set<string>();
  const directories = readdirSync(root).sort((first, second) =>
    Buffer.compare(Buffer.from(first), Buffer.from(second)),
  );

  for (const name of directories) {
    if (name.startsWith(".")) continue;

    try {
      if (!statSync(join(root, name)).isDirectory()) continue;
    } catch {
      continue;
    }

    const conf = join(root, name, "reviewer.conf");
    try {
      lstatSync(conf);
    } catch {
      continue;
    }

    const refuse = (reason: string): never => {
      throw new Error(`reviewers: ${conf}: ${reason}`);
    };

    let content: string;
    try {
      if (!isFile(conf)) refuse("not a readable regular file");
      accessSync(conf, constants.R_OK);
      content = readFileSync(conf, "utf8");
    } catch {
      refuse("not a readable regular file");
    }

    if (!reviewerName.test(name)) refuse("invalid reviewer name");

    const fields = new Map<string, string>();
    const settings: Setting[] = [];
    for (const raw of content!.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (!line || line.startsWith("#")) continue;
      if (!/^[A-Z][A-Z0-9_]*=/.test(line)) refuse("malformed line");

      const separator = line.indexOf("=");
      const field = line.slice(0, separator);
      const entry = line.slice(separator + 1);
      if (fields.has(field)) refuse(`duplicate ${field}`);

      if (field.startsWith("SETTING_")) {
        if (!/^SETTING_[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(field))
          refuse(`invalid setting key: ${field}`);

        const split = entry.indexOf(" ");
        const defaultValue = entry.slice(0, split);
        const pattern = entry.slice(split + 1);
        if (split < 0 || !pattern || !/^\S+$/.test(defaultValue))
          refuse(`invalid setting value: ${entry}`);

        if (/\(\?|\\[A-Za-z0-9]|\[\[:|\{,|[?*+}]\?|[*+]\+/.test(pattern))
          refuse(`pattern is not in the shared JavaScript RegExp and POSIX ERE subset: ${pattern}`);

        try {
          new RegExp(pattern);
        } catch {
          refuse(`invalid regex: ${pattern}`);
        }

        if (!matchesSetting(pattern, defaultValue))
          refuse(`default ${defaultValue} does not match ${pattern}`);

        const settingName = field.slice(8).toLowerCase().replaceAll("_", "-");
        const key = `${name}_${field.slice(8)}`.toUpperCase().replaceAll("-", "_");
        if (claims.has(key)) refuse(`setting key ${key} is claimed twice`);

        claims.add(key);
        settings.push({ name: settingName, key, defaultValue, pattern });
      }

      if (["NAME", "LOGINS", "HANDLES", "TRIGGER", "CHECK", "OUTSIDE_DIFF"].includes(field))
        if (!/\S/.test(entry)) refuse(`empty ${field}`);

      if (field === "LOGINS")
        for (const login of entry.trim().split(/\s+/))
          if (!/^[A-Za-z0-9-]+(\[bot\])?$/.test(login)) refuse(`invalid login: ${login}`);

      if (field === "HANDLES")
        for (const handle of entry.trim().split(/\s+/))
          if (!handle.startsWith("@")) refuse(`invalid handle: ${handle}`);

      fields.set(field, entry);
    }

    for (const field of ["NAME", "LOGINS", "HANDLES", "TRIGGER", "CHECK"])
      if (!fields.has(field)) refuse(`missing ${field}`);

    const logins = fields.get("LOGINS")!.trim().split(/\s+/);
    for (const login of logins) {
      const plain = login.replace(/\[bot\]$/, "");
      if (!logins.includes(plain) || !logins.includes(`${plain}[bot]`))
        refuse(`login ${login} needs both ${plain} and ${plain}[bot]`);
    }

    const handles = fields.get("HANDLES")!.trim().split(/\s+/);
    const trigger = fields.get("TRIGGER")!;

    if (!handles.some((handle) => trigger.toLowerCase().startsWith(handle.toLowerCase())))
      refuse("TRIGGER does not start with one of its HANDLES");

    declarations.push({
      name,
      displayName: fields.get("NAME")!,
      logins,
      handles,
      trigger,
      check: fields.get("CHECK")!,
      ...(fields.has("OUTSIDE_DIFF") ? { outsideDiff: fields.get("OUTSIDE_DIFF")! } : {}),
      settings,
    });
  }

  return declarations;
}
