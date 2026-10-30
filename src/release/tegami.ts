import { join } from "node:path";
import type { Draft, PublishTaskContext, TegamiPlugin } from "tegami";
import { tegami } from "tegami";
import { runCli } from "tegami/cli";
import { GitTagPublishTask } from "tegami/plugins/git";
import { github } from "tegami/plugins/github";
import { isCI } from "tegami/utils";
import {
  addedIn,
  assertEntries,
  assertHeadings,
  changelogSection,
  git,
  packageName,
  parseChange,
  renderRelease,
  versionBranch,
} from "./notes.ts";
import { openVersionPr } from "./version-pr.ts";

const [command, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");
let applied = false;

if (command === "publish" && !dryRun && !isCI())
  throw new Error("Publish outside CI: the Publish workflow on main is the only publisher");

function assertNotes(draft: Draft, changelogDir: string) {
  assertHeadings(changelogDir);

  if (!draft.hasPending())
    throw new Error(`No pending notes in .tegami/: add one naming ${packageName} and its bump`);

  assertEntries(draft.getChangelogs());
}

function tagExists(cwd: string, tag: string) {
  try {
    git(cwd, ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`]);
    return true;
  } catch {}

  try {
    git(cwd, ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

class ReleaseTagTask extends GitTagPublishTask {
  description = "Release the skills through their v<version> tag.";

  async status({ context, plan }: PublishTaskContext) {
    const tag = plan.packages.get(this.pkg.id)?.git?.tag;
    if (tag && !tagExists(context.cwd, tag)) return "pending" as const;
  }
}

function skills(): TegamiPlugin {
  return {
    name: "skills",
    enforce: "pre",
    init() {
      // Tegami always adds its npm plugin, which would npm publish the package once publishPreflight below forces it in.
      for (const plugin of this.plugins) if (plugin.name === "npm") plugin.publishTasks = undefined;
    },
    initCliDraft(draft) {
      if (command === "version") assertNotes(draft, this.changelogDir);
    },
    async applyCliDraft() {
      applied = true;
      if (!isCI()) return;

      const { repo, token } = this.github ?? {};
      if (!repo || !token)
        throw new Error("The version PR needs GITHUB_REPOSITORY and GITHUB_TOKEN");

      const version = this.graph.getByName(packageName)[0]?.version;
      if (!version) throw new Error(`${packageName} has no version to release`);

      const { pr } = await openVersionPr({
        cwd: this.cwd,
        repo,
        token,
        branch: versionBranch,
        base: "main",
        title: `chore: release ${version}`,
        body: changelogSection(this.cwd, version),
      });

      console.log(`https://github.com/${repo}/pull/${pr}`);
    },
    initPublishPlan({ plan }) {
      for (const [id, packagePlan] of plan.packages) {
        const version = this.graph.get(id)?.version;
        if (version) packagePlan.git = { ...packagePlan.git, tag: `v${version}` };
      }
    },
    publishPreflight({ pkg }) {
      if (pkg.name === packageName) return { shouldPublish: pkg.version !== undefined };
    },
    publishTasks({ plan }) {
      return plan.getPackagesToPublish().map((pkg) => new ReleaseTagTask(pkg));
    },
    beforePublishAll({ plan }) {
      if (!plan.options.dryRun) {
        if (!this.github?.repo || !this.github.token)
          throw new Error(
            "Publish needs GITHUB_REPOSITORY and GITHUB_TOKEN to push the release tag",
          );

        return;
      }

      for (const pkg of plan.getPackagesToPublish())
        console.log(`git tag ${plan.packages.get(pkg.id)?.git?.tag}`);
    },
  };
}

const paper = tegami({
  npm: { updateLockFile: false },
  generator: {
    generate({ pkg, packageDraft }) {
      const changes = (packageDraft.changelogs ?? []).flatMap((entry) => {
        const reference = addedIn(this.cwd, join(this.changelogDir, entry.filename));
        return entry.sections.map((section) => parseChange(entry.filename, section, reference));
      });

      return renderRelease(`${pkg.version}`, changes, new Date());
    },
  },
  plugins: [github({ release: false, versionPr: false }), skills()],
});

async function previewVersion() {
  const draft = await paper.draft();
  const { graph, changelogDir } = await paper._internal.context();
  assertNotes(draft, changelogDir);

  const pkg = graph.getByName(packageName)[0];
  const bumped = pkg && draft.getPackageDraft(pkg.id)?.bumpVersion(pkg);
  console.log(`${pkg?.version} -> ${bumped ?? pkg?.version}`);
}

if (command === "version" && dryRun) await previewVersion();
else await runCli(paper);

if (command === "version" && !dryRun && !applied) {
  console.error("Tegami wrote no publish lock");
  process.exitCode = 1;
}
