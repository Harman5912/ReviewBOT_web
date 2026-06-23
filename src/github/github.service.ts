import { Injectable, Logger } from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { logger } from '../common/utils/logger';

interface ReviewComment {
  body: string;
  path: string;
  line: number;
  side: string;
}

interface CheckRunOptions {
  name: string;
  head_sha: string;
  status: string;
  conclusion: string;
  output: {
    title: string;
    summary: string;
  };
}

@Injectable()
export class GithubService {
  private readonly logger = new Logger(GithubService.name);
  private readonly octokit: Octokit;
  private readonly cloneBasePath: string;

  constructor() {
    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.GITHUB_APP_ID || '',
        privateKey: process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, '\n') || '',
      },
    });
    this.cloneBasePath = process.env.CLONE_BASE_PATH || '/tmp/reviewbot';
  }

  private async getInstallationOctokit(
    repository: Record<string, any>,
  ): Promise<Octokit> {
    let installationId = repository?.installation?.id;

    if (!installationId) {
      // Look up the installation ID via the GitHub API
      const repoFullName = repository?.full_name;
      if (!repoFullName) {
        throw new Error('No installation ID or repository full_name found');
      }

      try {
        const { data: installation } =
          await this.octokit.rest.apps.getRepoInstallation({
            owner: repoFullName.split('/')[0],
            repo: repoFullName.split('/')[1],
          });
        installationId = installation.id;
        this.logger.log(
          `Looked up installation ID ${installationId} for ${repoFullName}`,
        );
      } catch (error: any) {
        this.logger.error(
          `Failed to look up installation for ${repoFullName}: ${error.message}`,
        );
        throw new Error(
          `No installation found for repository ${repoFullName}. Make sure the GitHub App is installed on this repository.`,
        );
      }
    }

    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.GITHUB_APP_ID || '',
        privateKey: process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, '\n') || '',
        installationId,
      },
    });
  }

  async cloneRepository(
    repository: Record<string, any>,
    ref: string,
  ): Promise<string> {
    const clonePath = path.join(
      this.cloneBasePath,
      repository.full_name.replace('/', '_'),
      ref.substring(0, 8),
    );

    if (fs.existsSync(clonePath)) {
      this.logger.log(`Using existing clone: ${clonePath}`);
      return clonePath;
    }

    // Get the installation-scoped octokit (it looks up the installation ID internally)
    const octokit = await this.getInstallationOctokit(repository);

    // Extract the installation ID from the octokit auth options
    // We need it for createInstallationAccessToken
    let installId = repository?.installation?.id;
    if (!installId) {
      const repoFullName = repository?.full_name;
      if (repoFullName) {
        const [owner, repoName] = repoFullName.split('/');
        const { data: inst } = await this.octokit.rest.apps.getRepoInstallation({ owner, repo: repoName });
        installId = inst.id;
        this.logger.log(`Looked up installation ID ${installId} for ${repoFullName}`);
      }
    }
    if (!installId) {
      throw new Error(`Cannot determine installation ID for ${repository?.full_name}`);
    }

    const { data: tokenData } =
      await octokit.rest.apps.createInstallationAccessToken({
        installation_id: installId,
      });

    // Get clone_url — may not be present in webhook payload, so fetch from API if needed
    let cloneUrl = repository.clone_url;
    if (!cloneUrl) {
      const { data: repoData } = await octokit.rest.repos.get({
        owner: repository.owner.login,
        repo: repository.name,
      });
      cloneUrl = repoData.clone_url;
      this.logger.log(`Fetched clone_url from API for ${repository.full_name}`);
    }

    const authenticatedUrl = cloneUrl.replace(
      'https://',
      `https://x-access-token:${tokenData.token}@`,
    );

    fs.mkdirSync(path.dirname(clonePath), { recursive: true });

    execSync(`git clone --depth=50 --branch ${ref} ${authenticatedUrl} ${clonePath}`, {
      stdio: 'pipe',
      timeout: 120000,
    });

    this.logger.log(`Cloned ${repository.full_name}@${ref} to ${clonePath}`);
    return clonePath;
  }

  async getPullRequestDiff(
    repository: Record<string, any>,
    prNumber: number,
  ): Promise<string> {
    const octokit = await this.getInstallationOctokit(repository);

    const { data } = await octokit.rest.pulls.get({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: prNumber,
      mediaType: { format: 'diff' },
    });

    return data as unknown as string;
  }

  async postReviewComment(
    repository: Record<string, any>,
    prNumber: number,
    comment: ReviewComment,
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(repository);

    // Get the PR's latest commit for the review
    const { data: pr } = await octokit.rest.pulls.get({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: prNumber,
    });

    // Create a review with comments
    await octokit.rest.pulls.createReview({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: prNumber,
      commit_id: pr.head.sha,
      event: 'COMMENT',
      comments: [
        {
          path: comment.path,
          line: comment.line,
          side: comment.side as any,
          body: comment.body,
        },
      ],
    });
  }

  async postIssueComment(
    repository: Record<string, any>,
    issueNumber: number,
    body: string,
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(repository);

    await octokit.rest.issues.createComment({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: issueNumber,
      body,
    });
  }

  async createCheckRun(
    repository: Record<string, any>,
    options: CheckRunOptions,
  ): Promise<any> {
    const octokit = await this.getInstallationOctokit(repository);

    const { data } = await octokit.rest.checks.create({
      owner: repository.owner.login,
      repo: repository.name,
      name: options.name,
      head_sha: options.head_sha,
      status: options.status as any,
      conclusion: options.conclusion as any,
      output: options.output,
    });

    return data;
  }

  async getRepositoryConfig(
    repository: Record<string, any>,
  ): Promise<Record<string, any> | null> {
    const octokit = await this.getInstallationOctokit(repository);

    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: repository.owner.login,
        repo: repository.name,
        path: '.github/reviewbot.yaml',
      });

      if ('content' in data) {
        const yaml = await import('js-yaml');
        return yaml.load(
          Buffer.from(data.content, 'base64').toString('utf-8'),
        ) as Record<string, any>;
      }
    } catch (error: any) {
      if (error.status !== 404) {
        this.logger.warn(
          `Failed to read reviewbot.yaml: ${error.message}`,
        );
      }
    }

    return null;
  }

  async getRateLimits(
    repository: Record<string, any>,
  ): Promise<{ remaining: number; reset: number }> {
    const octokit = await this.getInstallationOctokit(repository);
    const { data } = await octokit.rest.rateLimit.get();
    return {
      remaining: data.rate.remaining,
      reset: data.rate.reset,
    };
  }

  /** List repositories where the GitHub App is installed */
  async listInstallations(): Promise<Array<{
    id: number;
    account: { login: string; avatar_url: string; type: string };
    repositories_url: string;
  }>> {
    const { data } = await this.octokit.rest.apps.listInstallations();
    return data.map((inst: any) => ({
      id: inst.id,
      account: {
        login: inst.account.login,
        avatar_url: inst.account.avatar_url,
        type: inst.account.type,
      },
      repositories_url: inst.repositories_url,
    }));
  }

  /** List ALL repos the GitHub App is installed on (paginated).
   *  Uses an installation-scoped Octokit with GET /installation/repositories.
   *  The GitHub App needs "Repository permissions: Metadata (Read-only)" minimum.
   */
  async listInstallationRepos(installationId: number): Promise<Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    description: string | null;
    html_url: string;
    default_branch: string;
    open_issues_count: number;
    updated_at: string;
  }>> {
    // Create installation-scoped Octokit — this generates an installation access token
    // which can call /installation/repositories to list ALL repos the app can access
    const installOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.GITHUB_APP_ID || '',
        privateKey: process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, '\n') || '',
        installationId,
      },
    });

    const allRepos: any[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const response = await installOctokit.request(
        'GET /installation/repositories',
        { per_page: perPage, page },
      );

      const repos = response.data.repositories || [];
      if (repos.length === 0) break;
      allRepos.push(...repos);
      if (repos.length < perPage) break;
      page++;
      if (page > 10) break;
    }

    this.logger.log(
      `Listed ${allRepos.length} repos for installation ${installationId}`,
    );

    return allRepos.map((repo: any) => ({
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      private: repo.private,
      description: repo.description,
      html_url: repo.html_url,
      default_branch: repo.default_branch,
      open_issues_count: repo.open_issues_count,
      updated_at: repo.updated_at,
    }));
  }

  /** List open PRs for a repository */
  async listPullRequests(
    repository: Record<string, any>,
    state: string = 'open',
    perPage: number = 30,
  ): Promise<Array<{
    number: number;
    title: string;
    state: string;
    user: { login: string; avatar_url: string };
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    html_url: string;
    created_at: string;
    updated_at: string;
    draft: boolean;
  }>> {
    const octokit = await this.getInstallationOctokit(repository);
    const { data } = await octokit.rest.pulls.list({
      owner: repository.owner.login,
      repo: repository.name,
      state: state as any,
      per_page: perPage,
      sort: 'updated',
      direction: 'desc',
    });
    return data.map((pr: any) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      user: { login: pr.user.login, avatar_url: pr.user.avatar_url },
      head: { ref: pr.head.ref, sha: pr.head.sha },
      base: { ref: pr.base.ref, sha: pr.base.sha },
      html_url: pr.html_url,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      draft: pr.draft,
    }));
  }

  /** Get full PR details */
  async getPullRequest(
    repository: Record<string, any>,
    prNumber: number,
  ): Promise<Record<string, any>> {
    const octokit = await this.getInstallationOctokit(repository);
    const { data } = await octokit.rest.pulls.get({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: prNumber,
    });
    return data as any;
  }

  /** Apply a fix by committing a file change to the PR branch */
  async applyFix(
    repository: Record<string, any>,
    branch: string,
    filePath: string,
    newContent: string,
    commitMessage: string,
  ): Promise<{ sha: string; commit: any }> {
    const octokit = await this.getInstallationOctokit(repository);

    // Get the current file SHA (if it exists)
    let fileSha: string | undefined;
    try {
      const { data: fileData } = await octokit.rest.repos.getContent({
        owner: repository.owner.login,
        repo: repository.name,
        path: filePath,
        ref: branch,
      });
      if (!Array.isArray(fileData) && 'sha' in fileData) {
        fileSha = fileData.sha;
      }
    } catch {
      // File doesn't exist yet — will create it
    }

    const { data } = await octokit.rest.repos.createOrUpdateFileContents({
      owner: repository.owner.login,
      repo: repository.name,
      path: filePath,
      message: commitMessage,
      content: Buffer.from(newContent).toString('base64'),
      branch,
      sha: fileSha,
    });

    return { sha: data.content?.sha || '', commit: data.commit };
  }

  /** Create a fix branch from the PR's head and apply all fixes */
  async createFixBranch(
    repository: Record<string, any>,
    prNumber: number,
    fixes: Array<{ file: string; content: string; commitMessage: string }>,
    targetBranch?: string,
  ): Promise<{ branch: string; commitShas: string[] }> {
    const octokit = await this.getInstallationOctokit(repository);

    // Get PR details
    const { data: pr } = await octokit.rest.pulls.get({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: prNumber,
    });

    const sourceBranch = pr.head.ref;
    const fixBranch = targetBranch || `reviewbot-fixes/${prNumber}/${Date.now()}`;

    // Get the SHA of the source branch tip
    const { data: refData } = await octokit.rest.git.getRef({
      owner: repository.owner.login,
      repo: repository.name,
      ref: `heads/${sourceBranch}`,
    });

    // Create new branch from the PR head (or use existing target branch)
    try {
      await octokit.rest.git.createRef({
        owner: repository.owner.login,
        repo: repository.name,
        ref: `refs/heads/${fixBranch}`,
        sha: refData.object.sha,
      });
    } catch (error: any) {
      // Branch may already exist — update it to the latest PR head
      if (error.status === 422) {
        this.logger.log(`Branch "${fixBranch}" already exists, updating...`);
        await octokit.rest.git.updateRef({
          owner: repository.owner.login,
          repo: repository.name,
          ref: `heads/${fixBranch}`,
          sha: refData.object.sha,
          force: true,
        });
      } else {
        throw error;
      }
    }

    // Apply each fix as a commit
    const commitShas: string[] = [];
    for (const fix of fixes) {
      const result = await this.applyFix(
        repository,
        fixBranch,
        fix.file,
        fix.content,
        fix.commitMessage,
      );
      commitShas.push(result.commit.sha);
    }

    return { branch: fixBranch, commitShas };
  }

  /** Post a simple issue/PR comment */
  async postComment(
    repository: Record<string, any>,
    issueNumber: number,
    body: string,
  ): Promise<any> {
    const octokit = await this.getInstallationOctokit(repository);
    const { data } = await octokit.rest.issues.createComment({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: issueNumber,
      body,
    });
    return data;
  }

  // ── Branch Management ──

  /** List all branches for a repository */
  async listBranches(
    repository: Record<string, any>,
  ): Promise<Array<{ name: string; sha: string; protected: boolean }>> {
    const octokit = await this.getInstallationOctokit(repository);
    const allBranches: Array<{ name: string; sha: string; protected: boolean }> = [];
    let page = 1;
    while (true) {
      const { data } = await octokit.rest.repos.listBranches({
        owner: repository.owner.login,
        repo: repository.name,
        per_page: 100,
        page,
      });
      if (data.length === 0) break;
      allBranches.push(...data.map((b: any) => ({ name: b.name, sha: b.commit.sha, protected: b.protected || false })));
      if (data.length < 100) break;
      page++;
      if (page > 10) break;
    }
    return allBranches;
  }

  /** Get the default branch name for a repository */
  async getDefaultBranch(repository: Record<string, any>): Promise<string> {
    const octokit = await this.getInstallationOctokit(repository);
    const { data } = await octokit.rest.repos.get({
      owner: repository.owner.login,
      repo: repository.name,
    });
    return data.default_branch;
  }

  /** Get the default branch info (name + sha) for a repository */
  async getDefaultBranchInfo(repository: Record<string, any>): Promise<{ name: string; commit: { sha: string } }> {
    const name = await this.getDefaultBranch(repository);
    const sha = await this.getBranchSha(repository, name);
    return { name, commit: { sha } };
  }

  /** Get the latest SHA of a branch */
  async getBranchSha(
    repository: Record<string, any>,
    branch: string,
  ): Promise<string> {
    const octokit = await this.getInstallationOctokit(repository);
    const { data } = await octokit.rest.git.getRef({
      owner: repository.owner.login,
      repo: repository.name,
      ref: `heads/${branch}`,
    });
    return data.object.sha;
  }

  /** Get branch info including commit SHA */
  async getBranch(
    repository: Record<string, any>,
    branch: string,
  ): Promise<{ name: string; commit: { sha: string } }> {
    const octokit = await this.getInstallationOctokit(repository);
    const { data } = await octokit.rest.repos.getBranch({
      owner: repository.owner.login,
      repo: repository.name,
      branch,
    });
    return { name: data.name, commit: { sha: data.commit.sha } };
  }

  /** Get the diff between two branches as a unified diff string */
  async getBranchDiff(
    repository: Record<string, any>,
    baseBranch: string,
    headBranch: string,
  ): Promise<string> {
    const octokit = await this.getInstallationOctokit(repository);
    // Fetch compare data — returns files array with patches
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner: repository.owner.login,
      repo: repository.name,
      basehead: `${baseBranch}...${headBranch}`,
    }) as any;
    if (data.files && data.files.length > 0) {
      return data.files.map((f: any) =>
        `--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch || ''}`
      ).join('\n');
    }
    return '';
  }

  /** Compare two branches — returns ahead/behind counts */
  async compareBranches(
    repository: Record<string, any>,
    base: string,
    head: string,
  ): Promise<{ ahead_by: number; behind_by: number; status: string }> {
    const octokit = await this.getInstallationOctokit(repository);
    const { data } = await octokit.rest.repos.compareCommits({
      owner: repository.owner.login,
      repo: repository.name,
      base,
      head,
    });
    return {
      ahead_by: data.ahead_by,
      behind_by: data.behind_by,
      status: data.status, // "ahead", "behind", "diverged", "identical"
    };
  }

  /** Read a file from a specific branch */
  async readFile(
    repository: Record<string, any>,
    branch: string,
    filePath: string,
  ): Promise<{ content: string; sha: string } | null> {
    const octokit = await this.getInstallationOctokit(repository);
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: repository.owner.login,
        repo: repository.name,
        path: filePath,
        ref: branch,
      });
      if (!Array.isArray(data) && 'content' in data) {
        return {
          content: Buffer.from(data.content, 'base64').toString('utf-8'),
          sha: data.sha,
        };
      }
      return null; // directory
    } catch (error: any) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  /** List files in a directory on a branch (recursive) */
  async listFiles(
    repository: Record<string, any>,
    branch: string,
    dirPath: string = '',
  ): Promise<Array<{ path: string; type: 'file' | 'dir'; size: number }>> {
    const octokit = await this.getInstallationOctokit(repository);
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: repository.owner.login,
        repo: repository.name,
        path: dirPath,
        ref: branch,
      });
      if (Array.isArray(data)) {
        return data.map((item: any) => ({
          path: item.path,
          type: item.type === 'dir' ? 'dir' as const : 'file' as const,
          size: item.size || 0,
        }));
      }
      return [];
    } catch (error: any) {
      if (error.status === 404) return [];
      throw error;
    }
  }

  /** Write or update a single file on a branch */
  async writeFile(
    repository: Record<string, any>,
    branch: string,
    filePath: string,
    content: string,
    commitMessage: string,
  ): Promise<{ sha: string; commit: any }> {
    const octokit = await this.getInstallationOctokit(repository);

    // Get existing file SHA if it exists
    let fileSha: string | undefined;
    try {
      const { data: fileData } = await octokit.rest.repos.getContent({
        owner: repository.owner.login,
        repo: repository.name,
        path: filePath,
        ref: branch,
      });
      if (!Array.isArray(fileData) && 'sha' in fileData) {
        fileSha = fileData.sha;
      }
    } catch {
      // File doesn't exist — will be created
    }

    const { data } = await octokit.rest.repos.createOrUpdateFileContents({
      owner: repository.owner.login,
      repo: repository.name,
      path: filePath,
      message: commitMessage,
      content: Buffer.from(content).toString('base64'),
      branch,
      sha: fileSha,
    });

    return { sha: data.content?.sha || '', commit: data.commit };
  }

  /** Write multiple files to a branch in a single commit using the Git Data API (tree + commit) */
  async writeFiles(
    repository: Record<string, any>,
    branch: string,
    files: Array<{ path: string; content: string }>,
    commitMessage: string,
  ): Promise<{ sha: string; commit: any }> {
    const octokit = await this.getInstallationOctokit(repository);

    // Get the current branch ref
    const { data: refData } = await octokit.rest.git.getRef({
      owner: repository.owner.login,
      repo: repository.name,
      ref: `heads/${branch}`,
    });
    const currentCommitSha = refData.object.sha;

    // Get the current commit to get its tree
    const { data: currentCommit } = await octokit.rest.git.getCommit({
      owner: repository.owner.login,
      repo: repository.name,
      commit_sha: currentCommitSha,
    });

    // Create blobs for each file
    type TreeItem = { path: string; mode: '100644' | '100755' | '040000' | '160000' | '120000'; type: 'blob' | 'tree' | 'commit'; sha: string };
    const treeItems: TreeItem[] = [];
    for (const file of files) {
      const { data: blob } = await octokit.rest.git.createBlob({
        owner: repository.owner.login,
        repo: repository.name,
        content: Buffer.from(file.content).toString('base64'),
        encoding: 'base64',
      });
      treeItems.push({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      });
    }

    // Create a new tree
    const { data: newTree } = await octokit.rest.git.createTree({
      owner: repository.owner.login,
      repo: repository.name,
      base_tree: currentCommit.tree.sha,
      tree: treeItems as any,
    });

    // Create a new commit
    const { data: newCommit } = await octokit.rest.git.createCommit({
      owner: repository.owner.login,
      repo: repository.name,
      message: commitMessage,
      tree: newTree.sha,
      parents: [currentCommitSha],
    });

    // Update the branch ref
    await octokit.rest.git.updateRef({
      owner: repository.owner.login,
      repo: repository.name,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
    });

    return { sha: newCommit.sha, commit: newCommit };
  }

  /** Merge default branch into the given branch (sync with main) */
  async syncBranchWithDefault(
    repository: Record<string, any>,
    branch: string,
  ): Promise<{ merged: boolean; sha?: string; message: string }> {
    const octokit = await this.getInstallationOctokit(repository);
    const defaultBranch = await this.getDefaultBranch(repository);

    if (branch === defaultBranch) {
      return { merged: false, message: 'Already on default branch' };
    }

    try {
      const { data } = await octokit.rest.repos.merge({
        owner: repository.owner.login,
        repo: repository.name,
        base: branch,
        head: defaultBranch,
        commitMessage: `Sync ${branch} with ${defaultBranch} [ReviewBot]`,
      });
      return { merged: true, sha: data.sha, message: `Synced ${defaultBranch} into ${branch}` };
    } catch (error: any) {
      if (error.status === 409) {
        return { merged: false, message: 'Merge conflict — manual resolution needed' };
      }
      if (error.status === 204) {
        return { merged: false, message: 'Already up to date' };
      }
      throw error;
    }
  }

  /** Create a pull request from a branch */
  async createPullRequest(
    repository: Record<string, any>,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<{ number: number; html_url: string }> {
    const octokit = await this.getInstallationOctokit(repository);
    const { data } = await octokit.rest.pulls.create({
      owner: repository.owner.login,
      repo: repository.name,
      head,
      base,
      title,
      body,
    });
    return { number: data.number, html_url: data.html_url };
  }

  /** Get the full repository tree (all files) for a branch */
  async getRepositoryTree(
    repository: Record<string, any>,
    branch: string,
    recursive: boolean = true,
  ): Promise<Array<{ path: string; type: string; sha: string; size?: number }>> {
    const octokit = await this.getInstallationOctokit(repository);

    const sha = await this.getBranchSha(repository, branch);

    const { data } = await octokit.rest.git.getTree({
      owner: repository.owner.login,
      repo: repository.name,
      tree_sha: sha,
      recursive: recursive ? 'true' : undefined,
    });

    return (data.tree || []).map((item: any) => ({
      path: item.path || '',
      type: item.type || 'blob',
      sha: item.sha || '',
      size: item.size,
    }));
  }
}
