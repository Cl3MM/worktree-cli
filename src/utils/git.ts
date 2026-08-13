import { execa } from "execa";
import chalk from "chalk";

export async function getCurrentBranch(cwd: string = "."): Promise<string | null> {
    try {
        const { stdout } = await execa("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
        return stdout.trim();
    } catch (error) {
        // Handle case where HEAD is detached or not in a git repo
        console.error(chalk.yellow("Could not determine current branch."), error);
        return null;
    }
}

export async function isWorktreeClean(worktreePath: string = "."): Promise<boolean> {
    try {
        // Use --porcelain to get easily parsable output.
        // An empty output means clean (for tracked files).
        // We check the specific worktree path provided, defaulting to current dir.
        const { stdout } = await execa("git", ["-C", worktreePath, "status", "--porcelain"]);

        // If stdout is empty, the worktree is clean regarding tracked/staged files.
        // You might also consider ignoring untracked files depending on strictness,
        // but for operations like checkout, it's safer if it's fully clean.
        // If stdout has anything, it means there are changes (modified, staged, untracked, conflicts etc.)
        if (stdout.trim() === "") {
            return true;
        } else {
            // Optional: Log *why* it's not clean for better user feedback
            // console.warn(chalk.yellow("Git status details:\n" + stdout));
            return false;
        }
    } catch (error: any) {
        // If git status itself fails (e.g., not a git repo)
        console.error(chalk.red(`Failed to check git status for ${worktreePath}:`), error.stderr || error.message);
        // Treat failure to check as "not clean" or rethrow, depending on desired behavior.
        // Let's treat it as potentially unsafe to proceed.
        return false;
    }
}

// Add other git-related utilities here in the future

export async function isMainRepoBare(cwd: string = '.'): Promise<boolean> {
    try {
        // Find the root of the git repository
        const { stdout: gitDir } = await execa('git', ['-C', cwd, 'rev-parse', '--git-dir']);
        const mainRepoDir = gitDir.endsWith('/.git') ? gitDir.slice(0, -5) : gitDir; // Handle bare repo paths vs normal .git

        // Check the core.bare setting specifically for that repository path
        const { stdout: bareConfig } = await execa('git', ['config', '--get', '--bool', 'core.bare'], {
            cwd: mainRepoDir, // Check config in the main repo dir, not the potentially detached worktree CWD
        });

        // stdout will be 'true' or 'false' as a string
        return bareConfig.trim() === 'true';
    } catch (error: any) {
        // If the command fails (e.g., not a git repo, or config not set),
        // assume it's not bare, but log a warning.
        // A non-existent core.bare config defaults to false.
        if (error.exitCode === 1 && error.stdout === '' && error.stderr === '') {
            // This specific exit code/output means the config key doesn't exist, which is fine (defaults to false).
            return false;
        }
        console.warn(chalk.yellow(`Could not reliably determine if the main repository is bare. Proceeding cautiously. Error:`), error.stderr || error.message);
        return false; // Default to non-bare to avoid blocking unnecessarily, but warn the user.
    }
}

export async function getRepoRoot(cwd: string = "."): Promise<string | null> {
    try {
        const { stdout } = await execa("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
        return stdout.trim();
    } catch (error) {
        console.error(chalk.yellow("Could not determine repository root."), error);
        return null;
    }
}

/**
 * Resolves the start point to use when creating a NEW branch for a worktree
 * (i.e. the ref passed after `git worktree add -b <branch> <path> <ref>`).
 *
 * Historically this was omitted entirely, which makes git default to the
 * current HEAD of the main checkout - frequently stale, since the main
 * worktree is rarely pulled before spawning a new one. This resolves to the
 * remote's default branch instead, fetched fresh, so the new worktree is
 * born up to date.
 *
 * Fails open to the local HEAD (previous behavior) whenever the remote
 * lookup isn't possible: no `origin` remote, offline, or an undetectable
 * default branch. This preserves every legitimate use case (repo without a
 * remote, deliberate branching from local HEAD via --base HEAD, an
 * integration branch named something other than "main").
 */
export async function resolveNewBranchStartPoint(
    explicitBase: string | undefined,
    cwd: string = "."
): Promise<string> {
    if (explicitBase) {
        console.log(chalk.blue(`Base explicite demandée pour la nouvelle branche : ${explicitBase}`));
        return explicitBase;
    }

    try {
        await execa("git", ["-C", cwd, "remote", "get-url", "origin"]);
    } catch {
        console.log(chalk.gray("Pas de remote 'origin' détecté : la nouvelle branche part du HEAD local (comportement historique)."));
        return "HEAD";
    }

    let defaultBranch: string | null = null;
    try {
        const { stdout } = await execa("git", ["-C", cwd, "symbolic-ref", "refs/remotes/origin/HEAD"]);
        defaultBranch = stdout.trim().replace("refs/remotes/origin/", "");
    } catch {
        try {
            const { stdout } = await execa("git", ["-C", cwd, "remote", "show", "origin"]);
            const match = stdout.match(/HEAD branch:\s*(\S+)/);
            if (match) defaultBranch = match[1];
        } catch {
            // Remote injoignable (hors ligne ?) : on tombera sur le HEAD local plus bas.
        }
    }

    if (!defaultBranch) {
        console.warn(chalk.yellow("⚠️  Impossible de déterminer la branche par défaut de 'origin'. La nouvelle branche part du HEAD local, qui peut être périmé."));
        console.warn(chalk.yellow("   Vérifiez après création : git -C <worktree> rev-list --count HEAD..origin/<branche-integration>"));
        return "HEAD";
    }

    try {
        await execa("git", ["-C", cwd, "fetch", "origin", defaultBranch, "--quiet"]);
    } catch {
        console.warn(chalk.yellow(`⚠️  "git fetch origin ${defaultBranch}" a échoué (hors ligne ?). Utilisation du dernier état connu de origin/${defaultBranch} s'il existe, sinon repli sur le HEAD local.`));
    }

    const remoteRef = `origin/${defaultBranch}`;
    try {
        await execa("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", remoteRef]);
        console.log(chalk.green(`Base de la nouvelle branche : ${remoteRef} (à jour).`));
        return remoteRef;
    } catch {
        console.warn(chalk.yellow(`⚠️  ${remoteRef} introuvable localement. La nouvelle branche part du HEAD local, qui peut être périmé.`));
        console.warn(chalk.yellow(`   Remise à niveau après création : cd <worktree> && git fetch origin && git rebase origin/${defaultBranch}`));
        return "HEAD";
    }
}

export async function detectGitProvider(cwd: string = "."): Promise<'gh' | 'glab' | null> {
    try {
        const { stdout } = await execa("git", ["-C", cwd, "remote", "get-url", "origin"]);
        const remoteUrl = stdout.trim();

        if (remoteUrl.includes('github.com')) {
            return 'gh';
        } else if (remoteUrl.includes('gitlab.com') || remoteUrl.includes('gitlab')) {
            return 'glab';
        }

        return null;
    } catch (error) {
        console.error(chalk.yellow("Could not detect git provider from remote."), error);
        return null;
    }
}