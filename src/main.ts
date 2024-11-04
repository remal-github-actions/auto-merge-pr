import * as core from '@actions/core'
import { context } from '@actions/github'
import { components } from '@octokit/openapi-types'
import { newOctokitInstance } from './internal/octokit.js'

type PullRequest = components['schemas']['pull-request']
type PullRequestSimple = components['schemas']['pull-request-simple']
type CheckRunCompleted = components['schemas']['webhook-check-run-completed']
type DeploymentStatusCreated = components['schemas']['webhook-deployment-status-created']
type MergeMethod = NonNullable<components['schemas']['auto-merge']>['merge_method']

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const githubToken = core.getInput('githubToken', { required: true })
const requiredLabels = core.getInput('requiredLabels').split(/[\r\n,;]+/g).map(it => it.trim().toLowerCase()).filter(it => it.length)
const authors = core.getInput('authors').split(/[\r\n,;]+/g).map(it => it.trim().toLowerCase()).filter(it => it.length)
const preferredMergeOption = core.getInput('preferredMergeOption')
const dryRun = core.getInput('dryRun').toLowerCase() === 'true'

const octokit = newOctokitInstance(githubToken)

async function run(): Promise<void> {
    try {
        if (context.eventName === 'branch_protection_rule') {
            await processAllPrs()

        } else if (context.eventName === 'check_run') {
            await processCheckRunCompletedEvent(context.payload as CheckRunCompleted)

        } else if (context.eventName === 'deployment_status') {
            await processDeploymentStatusCreated(context.payload as DeploymentStatusCreated)

        } else if (context.eventName === 'pull_request') {
            core.warning(`Unsupported event: '${context.eventName}'`)

        } else if (context.eventName === 'pull_request_review') {
            core.warning(`Unsupported event: '${context.eventName}'`)

        } else if (context.eventName === 'push') {
            await processAllPrs()

        } else if (context.eventName === 'schedule') {
            await processAllPrs()

        } else if (context.eventName === 'status') {
            core.warning(`Unsupported event: '${context.eventName}'`)

        } else if (context.eventName === 'workflow_dispatch') {
            await processAllPrs()

        } else {
            core.warning(`Unsupported event: '${context.eventName}'`)
        }

    } catch (error) {
        core.setFailed(error instanceof Error ? error : `${error}`)
        throw error
    }
}

//noinspection JSIgnoredPromiseFromCall
run()

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

async function processPr(prParam: PullRequest | PullRequestSimple | number) {
    const prNumber = typeof prParam === 'number' ? prParam : prParam.number
    await core.group(`Processing PR #${prNumber}`, async () => {
        const pr = typeof prParam !== 'number' ? prParam : await octokit.pulls.get({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: prNumber,
        }).then(it => it.data)

        const baseRepo = pr.base.repo.html_url
        const headRepo = pr.head.repo?.html_url ?? ''
        if (baseRepo !== headRepo) {
            core.warning(`Skipping PR #${prNumber}: base's repo ${baseRepo} is different from head's repo ${headRepo}`)
            return
        }

        if (pr.merged_at) {
            core.warning(`Skipping PR #${prNumber}: already merged`)
            return
        }

        if (pr.auto_merge) {
            core.warning(`Skipping PR #${prNumber}: auto merge is already activated`)
            return
        }

        if (pr.draft) {
            core.warning(`Skipping PR #${prNumber}: draft`)
            return
        }

        if (requiredLabels.length) {
            if (!requiredLabels.every(label => pr.labels.some(it => it.name.toLowerCase() === label))) {
                core.warning(`Skipping PR #${prNumber}: doesn't have all required labels: ${requiredLabels.join(', ')}`)
                return
            }
        }

        if (authors.length) {
            const author = pr.user?.login?.toLowerCase() ?? ''
            if (!authors.includes(author)) {
                core.warning(`Skipping PR #${prNumber}: the author ${author} if not one of: ${authors.join(', ')}`)
                return
            }
        }

        if ((pr as PullRequest).mergeable === false) {
            core.warning(`Skipping PR #${prNumber}: not mergeable`)
            return
        }

        const hasRequiredChecks = await doesBranchHaveRequiredChecks(pr.base.ref)
        if (!hasRequiredChecks) {
            core.warning(`Skipping PR #${prNumber}: the base branch '${pr.base.ref}' doesn't have required status checks`)
            return
        }

        core.warning(`Merging PR #${prNumber}`)
        if (!dryRun) {
            await octokit.pulls.merge({
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: prNumber,
                sha: pr.head.sha,
                merge_method: preferredMergeOption.length ? (preferredMergeOption as MergeMethod) : undefined,
            })
        }
    })
}

async function doesBranchHaveRequiredChecks(branchName: string): Promise<boolean> {
    if (doesBranchHaveRequiredChecksCache.has(branchName)) {
        return doesBranchHaveRequiredChecksCache.get(branchName)!
    }

    const branch = await octokit.repos.getBranch({
        owner: context.repo.owner,
        repo: context.repo.repo,
        branch: branchName,
    }).then(it => it.data)

    const hasRequiredChecks = !!(
        branch.protection.enabled
        && branch.protection?.required_status_checks?.checks?.length
    )

    doesBranchHaveRequiredChecksCache.set(branchName, hasRequiredChecks)
    return hasRequiredChecks
}

const doesBranchHaveRequiredChecksCache = new Map<string, boolean>()

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

async function processAllPrs() {
    const responses = octokit.paginate.iterator(octokit.pulls.list, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        state: 'open',
    })
    for await (const response of responses) {
        for (const pr of response.data) {
            await processPr(pr)
        }
    }
}

async function processCheckRunCompletedEvent(event: CheckRunCompleted) {
    if (event.check_run.id === context.runId) {
        core.debug(`Skipping current check run: ${event.check_run.html_url}`)
        return
    }

    if (event.action !== 'completed') {
        core.debug(`Skipping check run by action: '${event.action}'`)
        return
    }

    if (!['success', 'skipped'].includes(event.check_run.conclusion ?? '')) {
        core.debug(`Skipping check run by conclusion: '${event.check_run.conclusion}'`)
        return
    }

    for (const prMini of event.check_run.pull_requests) {
        await processPr(prMini.number)
    }
}

async function processDeploymentStatusCreated(event: DeploymentStatusCreated) {
    if (event.deployment_status.state !== 'success') {
        core.debug(`Skipping deployment status by state: '${event.deployment_status.state}'`)
        return
    }

    await processAllPrs()
}
