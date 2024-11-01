import path from 'path'

const workspacePath = path.resolve(process.env.GITHUB_WORKSPACE ?? process.cwd())
export default workspacePath
