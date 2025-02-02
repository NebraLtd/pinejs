import { AsyncMigration } from '../../../../../src/migrator/utils';

const migration: AsyncMigration = {
	asyncFn: async (tx, _options) => {
		const staticSql = `\
		SELECT 1;
        `;

		return await tx.executeSql(staticSql);
	},
	asyncBatchSize: 1,
	syncFn: async (tx) => {
		const staticSql = `\
		SELECT 1;
        `;
		await tx.executeSql(staticSql);
	},
	delayMS: 50,
	backoffDelayMS: 1000,
	errorThreshold: 15,
	finalize: true,
};

export default migration;
