const SemVer = require('semver')
const gitFactory = require('simple-git')
const { execSync } = require('node:child_process')
const Fs = require('node:fs/promises')
const Os = require('node:os')
const Path = require('node:path')
const { findUp } = require('@kmamal/find-up')

const release = async (_path, type, options) => {
	const gitDir = await findUp('.git', { cwd: _path })
	if (!gitDir) {
		console.error("Not a git repository:", Path.resolve(_path))
		process.exit(1)
	}
	const path = Path.dirname(gitDir)
	const force = options?.force
	const shouldTest = !options?.noTest

	const pkgPath = Path.join(path, 'package.json')
	let pkg = JSON.parse(await Fs.readFile(pkgPath))

	if (pkg.scripts?.['update-exports']) {
		execSync('npm run update-exports', { cwd: path })
		pkg = JSON.parse(await Fs.readFile(pkgPath))
	}

	const git = gitFactory(path)
	await git.fetch()

	const status = await git.status()
	const problems = {}
	if (status.not_added.length !== 0) { problems.notAdded = status.not_added }
	if (status.conflicted.length !== 0) { problems.conflicted = status.conflicted }
	if (status.created.length !== 0) { problems.created = status.created }
	if (status.deleted.length !== 0) { problems.deleted = status.deleted }
	if (status.modified.length !== 0) { problems.modified = status.modified }
	if (status.renamed.length !== 0) { problems.renamed = status.renamed }
	if (status.staged.length !== 0) { problems.staged = status.staged }
	if (status.behind !== 0) { problems.behind = status.behind }
	if (status.ahead !== 0) { problems.ahead = status.ahead }
	if (!status.tracking) { problems.tracking = status.tracking }

	const isRepoClean = Object.keys(problems).length === 0
	if (!isRepoClean && !force) {
		console.error("Repo state not clean", problems)
		process.exit(1)
	}

	if (pkg.scripts?.test && shouldTest) {
		try {
			execSync('npm i && npm test', { cwd: path, stdio: 'inherit' })
		}
		catch (_) {
			console.error("Tests failed")
			process.exit(1)
		}
	}

	if (!isRepoClean) {
		await git.add('.')
		await git.commit('chore(commit): force')
		try {
			await git.push()
		}
		catch (_) {
			await git.push([ '-u', 'origin', 'master' ])
		}
	}

	let current = null
	try {
		current = (await git.raw([ 'describe', '--tags', '--abbrev=0', '--first-parent' ])).trim()
	}
	catch (error) {
		const isNoTags = (/no names found|cannot describe/iu).test(error.message ?? '')
		if (!isNoTags) { throw error }
	}

	const version = SemVer.parse(current ?? '0.0.0')
	if (!version) {
		throw Object.assign(new Error("Invalid tag"), {
			tag: current,
		})
	}

	if (current !== null && pkg.version !== version.toString()) {
		console.warn(`package.json version ${pkg.version} does not match latest tag ${current}`)
	}

	if (current !== null) {
		const distance = parseInt(await git.raw([ 'rev-list', '--count', '--first-parent', `${current}..HEAD` ]), 10)
		// Promoting a prerelease to a proper release needs no new commits
		const isPromotion = version.prerelease.length !== 0 && [ 'major', 'minor', 'patch' ].includes(type)
		if (distance === 0 && !isPromotion && !force) {
			console.error("No changes since", current)
			process.exit(1)
		}
	}

	try {
		version.inc(type)
	}
	catch (error) {
		throw Object.assign(new Error("Failed to increment"), {
			version: current,
			type,
			error,
		})
	}

	const versionString = version.toString()
	const tag = `v${versionString}`

	pkg.version = versionString
	await Fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

	execSync('npm i --ignore-scripts', { cwd: path, stdio: 'inherit' })

	await git.add('.')
	await git.commit(`chore(release): ${tag}`)

	await git.addTag(tag)

	await git.push()
	await git.pushTags()

	// Release binaries are built from the 'workflow' branch, so it must be
	// updated to the new version before the release workflow runs
	const remoteBranches = (await git.raw([ 'branch', '-r' ])).split('\n').map((x) => x.trim())
	if (remoteBranches.includes('origin/workflow')) {
		const branch = status.current

		console.log("update workflow branch")
		const worktree = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'release-worktree-'))
		try {
			const hasLocal = await git.raw([ 'show-ref', '--verify', 'refs/heads/workflow' ]).then(() => true, () => false)
			execSync(hasLocal
				? `git worktree add "${worktree}" workflow`
				: `git worktree add --track -b workflow "${worktree}" origin/workflow`
			, { cwd: path, stdio: 'inherit' })
			execSync('git reset --hard origin/workflow', { cwd: worktree, stdio: 'inherit' })

			const rebase = (args) => execSync(`git rebase ${args}`, {
				cwd: worktree,
				stdio: 'inherit',
				env: { ...process.env, GIT_EDITOR: 'true' },
			})

			try {
				rebase(branch)
			}
			catch (_) {
				// Resolve conflicts as they come, one replayed commit at a time
				for (let i = 0; ; i++) {
					if (i === 50) {
						rebase('--abort')
						throw new Error("Rebase of workflow branch did not converge")
					}

					const conflicts = execSync('git diff --name-only --diff-filter=U', { cwd: worktree })
						.toString().trim().split('\n').filter(Boolean)

					if (conflicts.length === 0) {
						// Stopped without conflicts: the replayed commit became empty
						try { rebase('--skip'); break }
						catch (__) { continue }
					}

					const onlyWorkflowFiles = conflicts.every((x) => x.startsWith('.github/workflows/'))
					if (!onlyWorkflowFiles) {
						rebase('--abort')
						throw Object.assign(new Error("Rebase of workflow branch failed"), { conflicts })
					}

					// The workflow branch keeps its own release.yml. During a
					// rebase its commits are the "theirs" side.
					execSync('git checkout --theirs -- .github/workflows/', { cwd: worktree })
					execSync('git add .github/workflows/', { cwd: worktree })

					try { rebase('--continue'); break }
					catch (__) { /* next commit stopped, loop */ }
				}
			}

			execSync('git push --force-with-lease origin workflow', { cwd: worktree, stdio: 'inherit' })
		}
		finally {
			execSync(`git worktree remove --force "${worktree}"`, { cwd: path })
		}

		console.log("dispatch release workflow")
		try {
			execSync('gh workflow run release.yml --ref workflow', { cwd: path, stdio: 'inherit' })
		}
		catch (_) {
			console.warn("Failed to dispatch. Run manually: gh workflow run release.yml --ref workflow")
		}
	}

	console.log(tag)
}

module.exports = { release }
