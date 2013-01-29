define([
	'has'
	'ometa!sbvr-parser/SBVRParser'
	'ometa!sbvr-compiler/LF2AbstractSQLPrep'
	'ometa!sbvr-compiler/LF2AbstractSQL'
	'cs!sbvr-compiler/AbstractSQL2SQL'
	'ometa!sbvr-compiler/AbstractSQLRules2SQL'
	'cs!sbvr-compiler/AbstractSQL2CLF'
	'ometa!server-glue/ServerURIParser'
	'ometa!server-glue/odata-parser'
	'async'
	'cs!database-layer/db'
	'underscore'
], (has, SBVRParser, LF2AbstractSQLPrep, LF2AbstractSQL, AbstractSQL2SQL, AbstractSQLRules2SQL, AbstractSQL2CLF, ServerURIParser, ODataParser, async, dbModule, _) ->
	exports = {}
	db = null

	devModel = '''
			Term:      model value
				Concept Type: JSON (Type)
			Term:      model
				Reference Scheme: model value
			Term:      vocabulary
				Concept Type: Short Text (Type)
			Term:      model type
				Concept Type: Short Text (Type)

			Fact Type: model is of vocabulary
				Necessity: Each model is of exactly one vocabulary
			Fact Type: model has model type
				Necessity: Each model has exactly one model type
			Fact Type: model has model value
				Necessity: Each model has exactly one model value'''

	transactionModel = '''
			Term:      resource id
				Concept type: Integer (Type)
			Term:      resource type
				Concept type: Text (Type)
			Term:      field name
				Concept type: Text (Type)
			Term:      field value
				Concept type: Text (Type)
			Term:      placeholder
				Concept type: Short Text (Type)

			Term:      resource
				Reference Scheme: resource id
			Fact type: resource has resource id
				Necessity: Each resource has exactly 1 resource id.
			Fact type: resource has resource type
				Necessity: Each resource has exactly 1 resource type.

			Term:      transaction

			Term:      lock
			Fact type: lock is exclusive
			Fact type: lock belongs to transaction
				Necessity: Each lock belongs to exactly 1 transaction.
			Fact type: resource is under lock
				Synonymous Form: lock is on resource
			Rule:      It is obligatory that each resource that is under a lock that is exclusive, is under at most 1 lock.

			Term:      conditional type
				Concept Type: Short Text (Type)
				Definition: "ADD", "EDIT" or "DELETE"

			Term:      conditional resource
			Fact type: conditional resource belongs to transaction
				Necessity: Each conditional resource belongs to exactly 1 transaction.
			Fact type: conditional resource has lock
				Necessity: Each conditional resource has at most 1 lock.
			Fact type: conditional resource has resource type
				Necessity: Each conditional resource has exactly 1 resource type.
			Fact type: conditional resource has conditional type
				Necessity: Each conditional resource has exactly 1 conditional type.
			Fact type: conditional resource has placeholder
				Necessity: Each conditional resource has at most 1 placeholder.
			--Rule:      It is obligatory that each conditional resource that has a placeholder, has a conditional type that is of "ADD".

			Term:      conditional field
				Reference Scheme: field name
			Fact type: conditional field has field name
				Necessity: Each conditional field has exactly 1 field name.
			Fact type: conditional field has field value
				Necessity: Each conditional field has at most 1 field value.
			Fact type: conditional field is of conditional resource
				Necessity: Each conditional field is of exactly 1 conditional resource.

			--Rule:      It is obligatory that each conditional resource that has a conditional type that is of "EDIT" or "DELETE", has a lock that is exclusive
			Rule:      It is obligatory that each conditional resource that has a lock, has a resource type that is of a resource that the lock is on.
			Rule:      It is obligatory that each conditional resource that has a lock, belongs to a transaction that the lock belongs to.'''

	userModel = '''
			Term:      username
				Concept Type: Short Text (Type)
			Term:      password
				Concept Type: Hashed (Type)
			Term:      user
				Reference Scheme: username
			Fact type: user has username
				Necessity: Each user has exactly one username.
				Necessity: Each username is of exactly one user.
			Fact type: user has password
				Necessity: Each user has exactly one password.'''

	serverURIParser = ServerURIParser.createInstance()
	odataParser = ODataParser.createInstance()

	seModels = {}
	sqlModels = {}
	clientModels = {}

	checkForConstraintError = (err, tableName) ->
		if (has('USE_MYSQL') and (matches = /ER_DUP_ENTRY: Duplicate entry '.*?[^\\]' for key '(.*?[^\\])'/.exec(err)) != null) or
				(has('USE_POSTGRES') and (matches = new RegExp('error: duplicate key value violates unique constraint "' + tableName + '_(.*?)_key"').exec(err)) != null)
			return ['"' + matches[1] + '" must be unique']
		else if err == 'could not execute statement (19 constraint failed)'
			# SQLite
			return ['Constraint failed']
		else
			return false

	getAndCheckBindValues = (bindings, values) ->
		bindValues = []
		for binding in bindings
			field = binding[1]
			fieldName = field[1]
			referencedName = binding[0] + '.' + fieldName
			value = if values[referencedName] == undefined then values[fieldName] else values[referencedName]
			{validated, value} = AbstractSQL2SQL.dataTypeValidate(value, field)
			if validated != true
				return '"' + fieldName + '" ' + validated
			bindValues.push(value)
		return bindValues

	endTransaction = (transactionID, callback) ->
		db.transaction((tx) ->
			placeholders = {}
			getLockedRow = (lockID, callback) ->
				tx.executeSql('''SELECT r."resource type", r."resource id"
								FROM "resource-is_under-lock" rl
								JOIN "resource" r ON rl."resource" = r."id"
								WHERE "lock" = ?;''', [lockID],
					(tx, row) -> callback(null, row)
					(tx, err) -> callback(err)
				)
			getFieldsObject = (conditionalResourceID, clientModel, callback) ->
				tx.executeSql('SELECT "field name", "field value" FROM "conditional_field" WHERE "conditional resource" = ?;', [conditionalResourceID],
					(tx, fields) ->
						fieldsObject = {}
						async.forEach(fields.rows,
							(field, callback) ->
								fieldName = field['field name']
								fieldName = fieldName.replace(clientModel.resourceName + '.', '')
								fieldValue = field['field value']
								async.forEach(clientModel.fields,
									(modelField, callback) ->
										placeholderCallback = (placeholder, resolvedID) ->
											if resolvedID == false
												callback('Placeholder failed' + fieldValue)
											else
												fieldsObject[fieldName] = resolvedID
												callback()
										if modelField[1] == fieldName and modelField[0] == 'ForeignKey' and _.isNaN(Number(fieldValue))
											if !placeholders.hasOwnProperty(fieldValue)
												return callback('Cannot resolve placeholder' + fieldValue)
											else if _.isArray(placeholders[fieldValue])
												placeholders[fieldValue].push(placeholderCallback)
											else
												placeholderCallback(fieldValue, placeholders[fieldValue])
										else
											fieldsObject[fieldName] = fieldValue
											callback()
									callback
								)
							(err) ->
								callback(err, fieldsObject)
						)
					(tx, err) -> callback(err)
				)
			resolvePlaceholder = (placeholder, resolvedID) ->
				placeholderCallbacks = placeholders[placeholder]
				placeholders[placeholder] = resolvedID
				for placeholderCallback in placeholderCallbacks
					placeholderCallback(placeholder, resolvedID)

			tx.executeSql('SELECT * FROM "conditional_resource" WHERE "transaction" = ?;', [transactionID],
				(tx, conditionalResources) ->
					conditionalResources.rows.forEach((conditionalResource) ->
						placeholder = conditionalResource.placeholder
						if placeholder? and placeholder.length > 0
							placeholders[placeholder] = []
					)

					# get conditional resources (if exist)
					async.forEach(conditionalResources.rows,
						(conditionalResource, callback) ->
							placeholder = conditionalResource.placeholder
							lockID = conditionalResource.lock
							doCleanup = () ->
								async.parallel([
										(callback) ->
											tx.executeSql('DELETE FROM "conditional_field" WHERE "conditional resource" = ?;', [conditionalResource.id],
												-> callback()
												(tx, err) -> callback(err)
											)
										(callback) ->
											tx.executeSql('DELETE FROM "conditional_resource" WHERE "lock" = ?;', [lockID],
												-> callback()
												(tx, err) -> callback(err)
											)
										(callback) ->
											tx.executeSql('DELETE FROM "resource-is_under-lock" WHERE "lock" = ?;', [lockID],
												-> callback()
												(tx, err) -> callback(err)
											)
										(callback) ->
											tx.executeSql('DELETE FROM "lock" WHERE "id" = ?;', [lockID],
												-> callback()
												(tx, err) -> callback(err)
											)
									]
									callback
								)

							clientModel = clientModels['data'].resources[conditionalResource['resource type']]
							uri = '/data/' + conditionalResource['resource type']
							requestBody = [{}]
							switch conditionalResource['conditional type']
								when 'DELETE'
									getLockedRow(lockID, (err, lockedRow) ->
										if err?
											callback(err)
										else
											lockedRow = lockedRow.rows.item(0)
											uri = uri + '?$filter=' + clientModel.idField + ' eq ' + lockedRow['resource id']
											runURI('DELETE', uri, requestBody, tx, doCleanup, -> callback(arguments))
									)
								when 'EDIT'
									getLockedRow(lockID, (err, lockedRow) ->
										if err?
											callback(err)
										else
											lockedRow = lockedRow.rows.item(0)
											uri = uri + '?$filter=' + clientModel.idField + ' eq ' + lockedRow['resource id']
											getFieldsObject(conditionalResource.id, clientModel,
												(err, fields) ->
													if err?
														callback(err)
													else
														runURI('PUT', uri, [fields], tx, doCleanup, -> callback(arguments))
											)
									)
								when 'ADD'
									getFieldsObject(conditionalResource.id, clientModel, (err, fields) ->
										if err?
											resolvePlaceholder(placeholder, false)
											callback(err)
										else
											runURI('POST', uri, [fields], tx,
												(result) ->
													resolvePlaceholder(placeholder, result.id)
													doCleanup()
												->
													resolvePlaceholder(placeholder, false)
													callback(arguments)
											)
									)
						(err) ->
							if err?
								callback(err)
							else
								tx.executeSql('DELETE FROM "transaction" WHERE "id" = ?;', [transactionID],
									(tx, result) ->
										validateDB(tx, sqlModels['data'],
											-> callback()
											(tx, err) -> callback(err)
										)
									(tx, err) ->
										callback(err)
								)
					)
				)
		)

	# successCallback = (tx, sqlmod, failureCallback, result)
	# failureCallback = (tx, errors)
	validateDB = (tx, sqlmod, successCallback, failureCallback) ->
		async.forEach(sqlmod.rules,
			(rule, callback) ->
				tx.executeSql(rule.sql, [],
					(tx, result) ->
						if result.rows.item(0).result in [false, 0, '0']
							callback(rule.structuredEnglish)
						else
							callback()
					(tx, err) -> callback(err)
				)
			(err) ->
				if err?
					tx.rollback()
					failureCallback(tx, err)
				else
					tx.end()
					successCallback(tx)
		)

	# successCallback = (tx, lfModel, slfModel, abstractSqlModel, sqlModel, clientModel)
	# failureCallback = (tx, errors)
	exports.executeModel = executeModel = (tx, vocab, seModel, successCallback, failureCallback) ->
		models = {}
		models[vocab] = seModel
		executeModels(tx, models, (err) ->
			if err?
				failureCallback(tx, err)
			successCallback(tx)
		)
	exports.executeModels = executeModels = (tx, models, callback) ->
		validateFuncs = []
		async.forEach(_.keys(models),
			(vocab, callback) ->
				seModel = models[vocab]
				try
					lfModel = SBVRParser.matchAll(seModel, 'Process')
				catch e
					console.error('Error parsing model', e)
					return callback('Error parsing model')
				slfModel = LF2AbstractSQLPrep.match(lfModel, 'Process')
				abstractSqlModel = LF2AbstractSQL.match(slfModel, 'Process')
				sqlModel = AbstractSQL2SQL.generate(abstractSqlModel)
				clientModel = AbstractSQL2CLF(sqlModel)

				# Create tables related to terms and fact types
				async.forEach(sqlModel.createSchema,
					(createStatement, callback) ->
						tx.executeSql(createStatement, null,
							-> callback()
							-> callback() # Warning: We ignore errors in the create table statements as SQLite doesn't support CREATE IF NOT EXISTS
						)
					(err, results) ->
						validateFuncs.push((callback) ->
							# Validate the [empty] model according to the rules.
							# This may eventually lead to entering obligatory data.
							# For the moment it blocks such models from execution.
							validateDB(tx, sqlModel,
								(tx) ->
									seModels[vocab] = seModel
									sqlModels[vocab] = sqlModel
									clientModels[vocab] = clientModel

									serverURIParser.setSQLModel(vocab, abstractSqlModel)
									odataParser.setSQLModel(vocab, abstractSqlModel)
									serverURIParser.setClientModel(vocab, clientModel)
									odataParser.setClientModel(vocab, clientModel)
									runURI('PUT', '/dev/model?$filter=model_type eq se', [{vocabulary: vocab, 'model value': seModel}], tx)
									runURI('PUT', '/dev/model?$filter=model_type eq lf', [{vocabulary: vocab, 'model value': lfModel}], tx)
									runURI('PUT', '/dev/model?$filter=model_type eq slf', [{vocabulary: vocab, 'model value': slfModel}], tx)
									runURI('PUT', '/dev/model?$filter=model_type eq abstractsql', [{vocabulary: vocab, 'model value': abstractSqlModel}], tx)
									runURI('PUT', '/dev/model?$filter=model_type eq sql', [{vocabulary: vocab, 'model value': sqlModel}], tx)
									runURI('PUT', '/dev/model?$filter=model_type eq client', [{vocabulary: vocab, 'model value': clientModel}], tx)

									callback()
								, (tx, err) ->
									callback(err)
							)
						)
						callback(err)
				)
			(err, results) ->
				async.parallel(validateFuncs, callback)
		)

	exports.deleteModel = (vocabulary) ->
		# TODO: This should be reorganised to be async.
		db.transaction(
			(tx) ->
				for dropStatement in sqlModels[vocabulary].dropSchema
					tx.executeSql(dropStatement)
				runURI('DELETE', '/dev/model?$filter=model_type eq se', [{vocabulary}], tx)
				runURI('DELETE', '/dev/model?$filter=model_type eq lf', [{vocabulary}], tx)
				runURI('DELETE', '/dev/model?$filter=model_type eq slf', [{vocabulary}], tx)
				runURI('DELETE', '/dev/model?$filter=model_type eq abstractsql', [{vocabulary}], tx)
				runURI('DELETE', '/dev/model?$filter=model_type eq sql', [{vocabulary}], tx)
				runURI('DELETE', '/dev/model?$filter=model_type eq client', [{vocabulary}], tx)

				seModels[vocabulary] = ''
				sqlModels[vocabulary] = []
				serverURIParser.setSQLModel(vocabulary, sqlModels[vocabulary])
				odataParser.setSQLModel(vocabulary, sqlModels[vocabulary])
				clientModels[vocabulary] = []
				serverURIParser.setClientModel(vocabulary, clientModels[vocabulary])
				odataParser.setClientModel(vocabulary, clientModels[vocabulary])
		)

	getID = (tree) ->
		query = tree.requests[0].query
		for whereClause in query when whereClause[0] == 'Where'
			# TODO: This should use the idField from sqlModel
			for comparison in whereClause[1..] when comparison[0] == "Equals" and comparison[1][2] in ['id']
				return comparison[2][1]
		return 0

	processInstances = (resourceModel, rows) ->
		# TODO: This can probably be optimised more, but removing the process step when it isn't required is an improvement
		processRequired = false
		for field in resourceModel.fields when field[0] == 'JSON'
			processRequired = true
			break
		instances = []
		if processRequired
			processInstance = (instance) ->
				instance = _.clone(instance)
				for field in resourceModel.fields when field[0] == 'JSON' and instance.hasOwnProperty(field[1])
					instance[field[1]] = JSON.parse(instance[field[1]])
				instances.push(instance)
		else
			processInstance = (instance) ->
				instances.push(instance)
		rows.forEach(processInstance)
		return instances

	processOData = (tree, request, rows) ->
		clientModel = clientModels[tree.vocabulary]
		resourceModel = clientModel.resources[request.resourceName]
		# TODO: This can probably be optimised more, but removing the process step when it isn't required is an improvement
		processRequired = false
		for field in resourceModel.fields when field[0] == 'ForeignKey' or field[0] == 'JSON'
			processRequired = true
			break
		instances = []
		if processRequired
			processInstance = (instance) ->
				instance = _.clone(instance)
				instance.__metadata =
					uri: ''
					type: ''
				for field in resourceModel.fields when instance.hasOwnProperty(field[1])
					switch field[0]
						when 'ForeignKey'
							instance[field[1]] =
								__deferred:
									uri: '/' + tree.vocabulary + '/' + field[4][0] + '?$filter=' + field[4][1] + ' eq ' + instance[field[1]]
								value: instance[field[1]]
						when 'JSON'
							instance[field[1]] = JSON.parse(instance[field[1]])
				instances.push(instance)
		else
			processInstance = (instance) ->
				instance = _.clone(instance)
				instance.__metadata =
					uri: ''
					type: ''
				instances.push(instance)
		rows.forEach(processInstance)
		return instances

	exports.runRule = do ->
		LF2AbstractSQLPrepHack = _.extend({}, LF2AbstractSQLPrep, {CardinalityOptimisation: () -> @_pred(false)})
		return (vocab, rule, callback) ->
			seModel = seModels[vocab]
			try
				lfModel = SBVRParser.matchAll(seModel + '\nRule: ' + rule, 'Process')
			catch e
				console.error('Error parsing model', e)
				return
			ruleLF = lfModel[lfModel.length-1]
			lfModel = lfModel[...-1]
			slfModel = LF2AbstractSQLPrep.match(lfModel, 'Process')
			slfModel.push(ruleLF)
			slfModel = LF2AbstractSQLPrepHack.match(slfModel, 'Process')
			
			abstractSqlModel = LF2AbstractSQL.match(slfModel, 'Process')
			
			ruleAbs = abstractSqlModel.rules[-1..][0]
			# Remove the not exists
			ruleAbs[2][1] = ruleAbs[2][1][1][1]
			# Select all
			ruleAbs[2][1][1][1] = '*'
			ruleSQL = AbstractSQL2SQL.generate({tables: {}, rules: [ruleAbs]}).rules[0].sql
			
			db.transaction((tx) ->
				tx.executeSql(ruleSQL, [],
					(tx, result) ->
						clientModel = clientModels[vocab]
						resourceModel = clientModel.resources[ruleLF[1][1][1][2][1]]
						data =
							instances: processInstances(resourceModel, result.rows)
							model: resourceModel
						callback(null, data)
					(tx, err) ->
						callback(err)
				)
			)

	exports.runURI = runURI = (method, uri, body = {}, tx, successCallback, failureCallback) ->
		uri = decodeURI(uri)
		console.log('Running URI', method, uri, body)
		try
			tree = serverURIParser.match([method, body, uri], 'Process')
		catch e
			tree = odataParser.match([method, body, uri], 'Process')
		req =
			tree: tree
			body: body
		res =
			send: (statusCode) ->
				if statusCode == 404
					failureCallback?()
				else
					successCallback?()
			json: (data) ->
				successCallback?(data)
		switch method
			when 'GET'
				runGet(req, res, tx)
			when 'POST'
				runPost(req, res, tx)
			when 'PUT'
				runPut(req, res, tx)
			when 'DELETE'
				runDelete(req, res, tx)

	exports.runGet = runGet = (req, res, tx) ->
		tree = req.tree
		if tree.requests == undefined
			res.json(clientModels[tree.vocabulary].resources)
		else if tree.requests[0].query?
			request = tree.requests[0]
			{query, bindings} = AbstractSQLRules2SQL.match(request.query, 'ProcessQuery')
			values = getAndCheckBindValues(bindings, request.values)
			console.log(query, values)
			if !_.isArray(values)
				res.json(values, 404)
			else
				runQuery = (tx) ->
					tx.executeSql(query, values,
						(tx, result) ->
							switch tree.type
								when 'Custom'
									if values.length > 0 && result.rows.length == 0
										res.send(404)
									else
										clientModel = clientModels[tree.vocabulary]
										resourceModel = clientModel.resources[request.resourceName]
										
										data =
											instances: processInstances(resourceModel, result.rows)
											model: resourceModel
										res.json(data)
								when 'OData'
									data =
										d: processOData(tree, request, result.rows)
									res.json(data)
						() ->
							res.send(404)
					)
				if tx?
					runQuery(tx)
				else
					db.transaction(runQuery)
		else
			clientModel = clientModels[tree.vocabulary]
			data =
				model:
					clientModel.resources[tree.requests[0].resourceName]
			res.json(data)

	exports.runPost = runPost = (req, res, tx) ->
		tree = req.tree
		if tree.requests == undefined
			res.send(404)
		else
			request = tree.requests[0]
			{query, bindings} = AbstractSQLRules2SQL.match(request.query, 'ProcessQuery')
			values = getAndCheckBindValues(bindings, request.values)
			console.log(query, values)
			if !_.isArray(values)
				res.json(values, 404)
			else
				vocab = tree.vocabulary
				runQuery = (tx) ->
					tx.begin()
					# TODO: Check for transaction locks.
					tx.executeSql(query, values,
						(tx, sqlResult) ->
							validateDB(tx, sqlModels[vocab],
								(tx) ->
									tx.end()
									insertID = if request.query[0] == 'UpdateQuery' then values[0] else sqlResult.insertId
									console.log('Insert ID: ', insertID)
									res.json({
											id: insertID
										}, {
											location: '/' + vocab + '/' + request.resourceName + "?filter=" + request.resourceName + ".id:" + insertID
										}, 201
									)
								(tx, errors) ->
									res.json(errors, 404)
							)
						(tx, err) ->
							constraintError = checkForConstraintError(err, request.resourceName)
							if constraintError != false
								res.json(constraintError, 404)
							else
								res.send(404)
					)
				if tx?
					runQuery(tx)
				else
					db.transaction(runQuery)

	exports.runPut = runPut = (req, res, tx) ->
		tree = req.tree
		if tree.requests == undefined
			res.send(404)
		else
			request = tree.requests[0]
			queries = AbstractSQLRules2SQL.match(request.query, 'ProcessQuery')

			if _.isArray(queries)
				insertQuery = queries[0]
				updateQuery = queries[1]
			else
				insertQuery = queries
			values = getAndCheckBindValues(insertQuery.bindings, request.values)
			console.log(insertQuery.query, values)

			if !_.isArray(values)
				res.json(values, 404)
			else
				vocab = tree.vocabulary

				doValidate = (tx) ->
					validateDB(tx, sqlModels[vocab],
						(tx) ->
							tx.end()
							res.send(200)
						(tx, errors) ->
							res.json(errors, 404)
					)

				id = getID(tree)
				runQuery = (tx) ->
					tx.begin()
					tx.executeSql('''
						SELECT NOT EXISTS(
							SELECT 1
							FROM "resource" r
							JOIN "resource-is_under-lock" AS rl ON rl."resource" = r."id"
							WHERE r."resource type" = ?
							AND r."id" = ?
						) AS result;''', [request.resourceName, id],
						(tx, result) ->
							if result.rows.item(0).result in [false, 0, '0']
								res.json([ "The resource is locked and cannot be edited" ], 404)
							else
								tx.executeSql(insertQuery.query, values,
									(tx, result) -> doValidate(tx)
									(tx) ->
										if updateQuery?
											values = getAndCheckBindValues(updateQuery.bindings, request.values)
											console.log(updateQuery.query, values)
											if !_.isArray(values)
												res.json(values, 404)
											else
												tx.executeSql(updateQuery.query, values,
													(tx, result) -> doValidate(tx)
													(tx, err) ->
														constraintError = checkForConstraintError(err, request.resourceName)
														if constraintError != false
															res.json(constraintError, 404)
														else
															res.send(404)
												)
										else
											res.send(404)
								)
					)
				if tx?
					runQuery(tx)
				else
					db.transaction(runQuery)

	exports.runDelete = runDelete = (req, res, tx) ->
		tree = req.tree
		if tree.requests == undefined
			res.send(404)
		else
			request = tree.requests[0]
			{query, bindings} = AbstractSQLRules2SQL.match(request.query, 'ProcessQuery')
			values = getAndCheckBindValues(bindings, request.values)
			console.log(query, values)
			if !_.isArray(values)
				res.json(values, 404)
			else
				vocab = tree.vocabulary
				runQuery = (tx) ->
					tx.begin()
					tx.executeSql(query, values,
						(tx, result) ->
							validateDB(tx, sqlModels[vocab]
								(tx) ->
									tx.end()
									res.send(200)
								(tx, errors) ->
									res.json(errors, 404)
							)
						() ->
							res.send(404)
					)
				if tx?
					runQuery(tx)
				else
					db.transaction(runQuery)

	exports.parseURITree = parseURITree = (req, res, next) ->
		if !req.tree?
			try
				uri = decodeURI(req.url)
				try
					req.tree = serverURIParser.match([req.method, req.body, uri], 'Process')
				catch e
					req.tree = odataParser.match([req.method, req.body, uri], 'Process')
				console.log(uri, req.tree, req.body)
			catch e
				console.error('Failed to parse URI tree', req.url, e.message, e.stack)
				req.tree = false
		if req.tree == false
			next('route')
		else
			next()

	exports.executeStandardModels = executeStandardModels = (tx, callback) ->
		executeModels(tx, {
				'dev': devModel
				'transaction': transactionModel
				'user': userModel
			},
			(err) ->
				if err?
					console.error('Failed to execute standard models.', err)
				else
					# TODO: Remove these hardcoded users.
					if has 'DEV'
						runURI('POST', '/user/user', [{'user.username': 'test', 'user.password': 'test'}], null)
						runURI('POST', '/user/user', [{'user.username': 'test2', 'user.password': 'test2'}], null)
					console.log('Sucessfully executed standard models.')
				callback?(err)
		)

	exports.setup = (app, requirejs, databaseOptions, callback) ->
		db = dbModule.connect(databaseOptions)
		AbstractSQL2SQL = AbstractSQL2SQL[databaseOptions.engine]
		db.transaction((tx) ->
			executeStandardModels(tx, (err) ->
				if err?
					console.error('Could not execute standard models')
					process.exit()
				runURI('GET', '/dev/model?$filter=model_type eq sql and vocabulary eq data', null, tx, (result) ->
					for instance in result.d
						vocab = instance.vocabulary
						sqlModel = instance['model value']
						clientModel = AbstractSQL2CLF(sqlModel)
						sqlModels[vocab] = sqlModel
						serverURIParser.setSQLModel(vocab, sqlModel)
						odataParser.setSQLModel(vocab, sqlModel)
						clientModels[vocab] = clientModel
						serverURIParser.setClientModel(vocab, clientModel)
						odataParser.setClientModel(vocab, clientModel)
				)
				runURI('GET', '/dev/model?$filter=model_type eq se and vocabulary eq data', null, tx, (result) ->
					for instance in result.d
						vocab = instance.vocabulary
						seModel = instance['model value']
						seModels[vocab] = seModel
				)
				# We only actually need to have had the standard models executed before execution continues, so we schedule it here.
				setTimeout(callback, 0)
			)
		)
		if has 'DEV'
			app.get('/dev/*', parseURITree, (req, res, next) ->
				runGet(req, res)
			)
		app.post('/transaction/execute', (req, res, next) ->
			id = Number(req.body.id)
			if _.isNaN(id)
				res.send(404)
			else
				endTransaction(id, (err) ->
					if err?
						console.error(err)
						res.json(err, 404)
					else
						res.send(200)
				)
		)
		app.get('/transaction', (req, res, next) ->
			res.json(
				transactionURI: "/transaction/transaction"
				conditionalResourceURI: "/transaction/conditional_resource"
				conditionalFieldURI: "/transaction/conditional_field"
				lockURI: "/transaction/lock"
				transactionLockURI: "/transaction/lock-belongs_to-transaction"
				resourceURI: "/transaction/resource"
				lockResourceURI: "/transaction/resource-is_under-lock"
				exclusiveLockURI: "/transaction/lock-is_exclusive"
				commitTransactionURI: "/transaction/execute"
			)
		)
		app.get('/transaction/*', parseURITree, (req, res, next) ->
			runGet(req, res)
		)
		app.post('/transaction/*', parseURITree, (req, res, next) ->
			runPost(req, res)
		)
		app.put('/transaction/*', parseURITree, (req, res, next) ->
			runPut(req, res)
		)
		app.del('/transaction/*', parseURITree, (req, res, next) ->
			runDelete(req, res)
		)

	return exports
)
