// Worker entrypoint (pnpm -F @app/worker start). Skeleton: validates config and exits.
import { createLogger, loadConfig } from '@app/core'

const config = loadConfig(process.env)
const logger = createLogger({ name: 'worker', level: config.LOG_LEVEL })
logger.info('worker skeleton: no job loop yet', { workerTypes: config.WORKER_TYPES })
