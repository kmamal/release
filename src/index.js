const SemVer = require('semver')
const gitFactory = require('simple-git/promise')
const Path = require('path')
const Fsp = require('fs').promises

const release = async (_path, type, options) => {
	const path = Path.resolve(_path)
	const force = options && options.force

	const pkg_path = Path.join(path, 'package.json')
	const pkg = require(pkg_path)

	const git = gitFactory(path)
	await git.fetch()

	const status = await git.status()
	const problems = {}
	if (status.not_added.length !== 0) { problems.not_added = status.not_added }
	if (status.conflicted.length !== 0) { problems.conflicted = status.conflicted }
	if (status.created.length !== 0) { problems.created = status.created }
	if (status.deleted.length !== 0) { problems.deleted = status.deleted }
	if (status.modified.length !== 0) { problems.modified = status.modified }
	if (status.renamed.length !== 0) { problems.renamed = status.renamed }
	if (status.staged.length !== 0) { problems.staged = status.staged }
	if (status.behind !== 0) { problems.behind = status.behind }
	if (status.ahead !== 0) { problems.ahead = status.ahead }
	if (!status.tracking) { problems.tracking = status.tracking }
	if (Object.keys(problems).length !== 0) {
		if (force) {
			await git.add('.')
			await git.commit('chore(commit): force')
			await git.push()
		} else {
			console.error("Repo state not clean", problems)
			process.exit(1)
		}
	}

	let current
	try {
		current = await git.raw([ 'describe', '--tags', '--first-parent' ])
		if (!current.includes('-') && !force) {
			console.error("No changes since", current)
			process.exit(1)
		}
		current = current.slice(0, current.indexOf('-'))
	} catch (error) {
		current = '0.0.0'
	}

	const version = SemVer.parse(current)
	if (!version) {
		const error = new Error("Invalid tag")
		error.tag = current
		throw error
	}

	try {
		version.inc(type)
	} catch (err) {
		const error = new Error("Failed to increment")
		error.version = current
		error.type = type
		error.error = error
		throw error
	}

	const version_string = version.toString()
	const tag = `v${version_string}`

	pkg.version = version_string
	await Fsp.writeFile(pkg_path, JSON.stringify(pkg, null, 2))
	await git.add('.')
	await git.commit(`chore(release): ${tag}`)

	await git.addTag(tag)

	await git.push()
	await git.pushTags()

	console.log(tag)
}

module.exports = { release }
