define [ 'lodash', 'bluebird', 'typed-error', 'text!migrator/migrations.sbvr' ], (_, Promise, TypedError, modelText) ->
	MigrationError: class MigrationError extends TypedError

	run: (tx, model) ->
		if not _.any(model.migrations)
			return Promise.fulfilled()

		modelName = model.apiRoot

		# migrations only run if the model has been executed before,
		# to make changes that can't be automatically applied
		@checkModelAlreadyExists(tx, modelName)
		.then (exists) =>
			if not exists
				@logger.info "First time model has executed, skipping migrations"
				return @setExecutedMigrations(tx, modelName, _.keys(model.migrations))

			@getExecutedMigrations(tx, modelName)
			.then (executedMigrations) =>
				pendingMigrations = @filterAndSortPendingMigrations(model.migrations, executedMigrations)
				return if not _.any(pendingMigrations)

				@executeMigrations(tx, pendingMigrations)
				.then (newlyExecutedMigrations) =>
					@setExecutedMigrations(tx, modelName, [ executedMigrations..., newlyExecutedMigrations... ])

	checkModelAlreadyExists: (tx, modelName) ->
		@sbvrUtils.api.dev.get
			resource: 'model'
			tx: tx
			options:
				select: [ 'vocabulary' ]
				top: '1'
				filter:
					vocabulary: modelName
		.then (results) ->
			_.any(results)

	getExecutedMigrations: (tx, modelName) ->
		@migrationsApi.get
			resource: 'migration'
			id: modelName
			tx: tx
			options:
				select: [ 'executed_migrations' ]
		.then (data) ->
			data?.executed_migrations || []

	setExecutedMigrations: (tx, modelName, executedMigrations) ->
		@migrationsApi.put
			resource: 'migration'
			id: modelName
			tx: tx
			body:
				model_name: modelName
				executed_migrations: executedMigrations

	# turns {"key1": migration, "key3": migration, "key2": migration}
	# into  [["key1", migration], ["key2", migration], ["key3", migration]]
	filterAndSortPendingMigrations: (migrations, executedMigrations) ->
		_(migrations)
		.omit(executedMigrations)
		.pairs()
		.sortBy(_.first)
		.value()

	executeMigrations: (tx, migrations=[]) ->
		Promise.map(migrations, @executeMigration.bind(this, tx), concurrency: 1)
		.catch (err) =>
			@logger.error "Error while executing migrations, rolled back"
			throw new MigrationError(err)
		.return(_.map(migrations, _.first)) # return migration keys

	executeMigration: (tx, [ key, migration ]) ->
		@logger.info "Running migration #{JSON.stringify key}"

		switch typeof migration
			when 'function'
				migration(tx, @sbvrUtils)
			when 'string'
				tx.executeSql(migration)

	config:
		models: [
			modelName: 'migrations'
			apiRoot: 'migrations'
			modelText: modelText
			customServerCode: 'cs!migrator/migrator'
		]

	setup: (app, requirejs, @sbvrUtils, db, callback) ->
		@migrationsApi = @sbvrUtils.api.migrations
		@logger = @migrationsApi.logger

		callback()

