define ['has', 'q', 'lodash', 'ometa!database-layer/SQLBinds'], (has, Q, _, SQLBinds) ->
	exports = {}
	DEFAULT_VALUE = {}
	bindDefaultValues = (sql, bindings) ->
		bindNo = 0
		SQLBinds.matchAll(sql, 'parse', [->
			if bindings[bindNo] == DEFAULT_VALUE
				bindings.splice(bindNo, 1)
				'DEFAULT'
			else
				bindNo++
				'?'
		])

	getStackTrace = ->
		try
			throw new Error()
		catch e
			stack = e.stack
			for i in [0...2]
				stack = stack.substring(stack.indexOf('\n') + 1)
			return stack

	class Tx
		timeoutMS = 500
		constructor: (stackTrace, executeSql, rollback, end) ->
			automaticClose = =>
				console.error('Transaction still open after ' + timeoutMS + 'ms without an execute call.', stackTrace)
				@rollback()
			automaticCloseTimeout = null
			resetTimeout = ->
				clearTimeout(automaticCloseTimeout)
				automaticCloseTimeout = setTimeout(automaticClose, timeoutMS)
			resetTimeout()

			@executeSql = (sql, bindings = [], callback, args...) ->
				resetTimeout()
				deferred = Q.defer()

				sql = bindDefaultValues(sql, bindings)
				executeSql(sql, bindings, deferred, args...)

				return deferred.promise.nodeify(callback)

			@rollback = (callback) ->
				deferred = Q.defer()

				rollback(deferred)
				closeTransaction('Transaction has been rolled back.')

				return deferred.promise.nodeify(callback)

			@end = (callback) ->
				deferred = Q.defer()

				end(deferred)
				closeTransaction('Transaction has been ended.')

				return deferred.promise.nodeify(callback)

			closeTransaction = (message) =>
				clearTimeout(automaticCloseTimeout)
				stackTrace = getStackTrace()
				promise = Q.reject(new Error(message))
				@executeSql = (sql, bindings, callback) ->
					# console.error(message, stackTrace)
					# console.trace()
					return promise.nodeify(callback)
				@rollback = @end = (sql, bindings, callback) ->
					# console.error(message, stackTrace)
					# console.trace()
					return promise.nodeify(callback)

	if has 'ENV_NODEJS'
		exports.postgres = (connectString) ->
			pg = require('pg')
			createResult = ({rowCount, rows}) ->
				return {
					rows:
						length: rows?.length or 0
						item: (i) -> rows[i]
						forEach: (iterator, thisArg) ->
							rows.forEach(iterator, thisArg)
						map: (iterator, thisArg) ->
							rows.map(iterator, thisArg)
					rowsAffected: rowCount
					insertId: rows[0]?.id || null
				}
			class PostgresTx extends Tx
				constructor: (_db, _close, _stackTrace) ->
					executeSql = (sql, bindings, deferred, addReturning = true) ->
						bindings = bindings.slice(0) # Deal with the fact we may splice arrays directly into bindings
						if addReturning and /^\s*INSERT\s+INTO/i.test(sql)
							sql = sql.replace(/;?$/, ' RETURNING id;')
						bindNo = 0
						sql = SQLBinds.matchAll(sql, 'parse', [
							->
								if Array.isArray(bindings[bindNo])
									initialBindNo = bindNo
									bindString = (
										for binding in bindings[initialBindNo]
											'$' + ++bindNo
									).join(',')
									Array.prototype.splice.apply(bindings, [initialBindNo, 1].concat(bindings[initialBindNo]))
									return bindString
								else if bindings[bindNo] == DEFAULT_VALUE
									bindings.splice(bindNo, 1)
									return 'DEFAULT'
								else
									return '$' + ++bindNo
						])
						_db.query {text: sql, values: bindings}, (err, res) ->
							if err
								console.warn(sql, bindings, err)
								deferred.reject(err)
							else
								deferred.resolve(createResult(res))

					rollback = (deferred) =>
						deferred.resolve(@executeSql('ROLLBACK;'))
						_close()

					end = (deferred) =>
						deferred.resolve(@executeSql('COMMIT;'))
						_close()

					super(_stackTrace, executeSql, rollback, end)

				tableList: (extraWhereClause = '', callback) ->
					if !callback? and typeof extraWhereClause is 'function'
						callback = extraWhereClause
						extraWhereClause = ''
					if extraWhereClause != ''
						extraWhereClause = ' WHERE ' + extraWhereClause
					@executeSql("SELECT * FROM (SELECT tablename as name FROM pg_tables WHERE schemaname = 'public') t" + extraWhereClause + ";", [], callback)
				dropTable: (tableName, ifExists = true, callback) ->
					@executeSql('DROP TABLE ' + (if ifExists is true then 'IF EXISTS ' else '') + '"' + tableName + '" CASCADE;', [], callback)
			return {
				DEFAULT_VALUE
				engine: 'postgres'
				transaction: (callback) ->
					stackTrace = getStackTrace()
					deferred = Q.defer()

					pg.connect connectString, (err, client, done) ->
						if err
							console.error('Error connecting ' + err)
							process.exit()
						tx = new PostgresTx(client, done, stackTrace)
						if process.env.PG_SCHEMA?
							tx.executeSql('SET search_path TO "' + process.env.PG_SCHEMA + '"')
						tx.executeSql('START TRANSACTION;')

						deferred.resolve(tx)

					deferred.promise.then(callback).catch (err) ->
						console.error(err, callback)
					return deferred.promise
			}

		exports.mysql = (options) ->
			mysql = new require('mysql')
			_pool = mysql.createPool(options)
			_pool.on 'connection', (err, _db) ->
				_db.query("SET sql_mode='ANSI_QUOTES';")

			createResult = (rows) ->
				return {
					rows:
						length: rows?.length or 0
						item: (i) -> rows[i]
						forEach: (iterator, thisArg) ->
							rows.forEach(iterator, thisArg)
						map: (iterator, thisArg) ->
							rows.map(iterator, thisArg)
					rowsAffected: rows.affectedRows
					insertId: rows.insertId || null
				}
			class MySqlTx extends Tx
				constructor: (_db, _stackTrace) ->
					executeSql = (sql, bindings, deferred) ->
						_db.query sql, bindings, (err, res) ->
							if err
								console.warn(sql, bindings, err)
								deferred.reject(err)
							else
								deferred.resolve(createResult(res))

					rollback = =>
						deferred.resolve(@executeSql('ROLLBACK;'))
						_db.end()

					end = (deferred) =>
						deferred.resolve(@executeSql('COMMIT;'))
						_db.end()

					super(_stackTrace, executeSql, rollback, end)

				tableList: (extraWhereClause = '', callback) ->
					if !callback? and typeof extraWhereClause is 'function'
						callback = extraWhereClause
						extraWhereClause = ''
					if extraWhereClause != ''
						extraWhereClause = ' WHERE ' + extraWhereClause
					@executeSql("SELECT name FROM (SELECT table_name as name FROM information_schema.tables WHERE table_schema = ?) t" + extraWhereClause + ";", [options.database], callback)
				dropTable: (tableName, ifExists = true, callback) ->
					@executeSql('DROP TABLE ' + (if ifExists is true then 'IF EXISTS ' else '') + '"' + tableName + '";', [], callback)
			return {
				DEFAULT_VALUE
				engine: 'mysql'
				transaction: (callback) ->
					stackTrace = getStackTrace()
					deferred = Q.defer()

					_pool.getConnection (err, _db) ->
						if err
							console.error('Error connecting ' + err)
							process.exit()
						tx = new MysqlTx(_db, stackTrace)
						tx.executeSql('START TRANSACTION;')

						deferred.resolve(tx)

					deferred.promise.then(callback).catch (err) ->
						console.error(err, callback)
					return deferred.promise
			}
	else
		exports.websql = (databaseName) ->
			_db = openDatabase(databaseName, '1.0', 'rulemotion', 2 * 1024 * 1024)
			createResult = (result) ->
				try
					insertId = result.insertId
				catch e
					insertId = null
					# Ignore the potential DOM exception.
				return {
					rows:
						length: result.rows.length
						item: (i) -> _.clone(result.rows.item(i))
						forEach: (args...) ->
							@map(args...)
							return
						map: (iterator, thisArg) ->
							for i in [0...result.rows.length] by 1
								iterator.call(thisArg, @item(i), i, result.rows)
					rowsAffected: result.rowsAffected 
					insertId: insertId
				}
			
			class WebSqlTx extends Tx
				constructor: (_tx, _stackTrace) ->
					running = true
					queue = []
					# This function is used to recurse executeSql calls and keep the transaction open,
					# allowing us to use async calls within the API.
					asyncRecurse = ->
						while args = queue.pop()
							console.debug('Running', args[0])
							_tx.executeSql(args...)
						if running is true
							console.debug('Looping')
							_tx.executeSql('SELECT 0', [], asyncRecurse)
					asyncRecurse()

					executeSql = (sql, bindings, deferred) ->
						# This is used so we can find the useful part of the stack trace, as WebSQL is asynchronous and starts a new stack.
						stackTrace = getStackTrace()

						successCallback = (_tx, _results) =>
							deferred.resolve(createResult(_results))
						errorCallback = (_tx, err) =>
							console.warn(sql, bindings, err, stackTrace)
							deferred.reject(err)

						sql = bindDefaultValues(sql, bindings)
						queue.push([sql, bindings, successCallback, errorCallback])

					rollback = (deferred) ->
						successCallback = ->
							deferred.resolve()
							throw 'Rollback'
						errorCallback = ->
							deferred.resolve()
							return true
						queue = [['RUN A FAILING STATEMENT TO ROLLBACK', [], successCallback, errorCallback]]
						running = false

					end = (deferred) ->
						deferred.resolve()
						running = false

					super(_stackTrace, executeSql, rollback, end)

				tableList: (extraWhereClause = '', callback) ->
					if !callback? and typeof extraWhereClause is 'function'
						callback = extraWhereClause
						extraWhereClause = ''
					if extraWhereClause != ''
						extraWhereClause = ' AND ' + extraWhereClause
					@executeSql("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT IN ('__WebKitDatabaseInfoTable__', 'sqlite_sequence')" + extraWhereClause + ';', [], callback)

				dropTable: (tableName, ifExists = true, callback) ->
					@executeSql('DROP TABLE ' + (if ifExists is true then 'IF EXISTS ' else '') + '"' + tableName + '";', [], callback)

			return {
				DEFAULT_VALUE
				engine: 'websql'
				transaction: (callback) ->
					stackTrace = getStackTrace()

					_db.transaction (_tx) ->
						deferred.resolve(new WebSqlTx(_tx, stackTrace))

					deferred = Q.defer()
					deferred.promise.then(callback).catch (err) ->
						console.error(err, callback)
					return deferred.promise
			}

	exports.connect = (databaseOptions) ->
		if !exports[databaseOptions.engine]? or databaseOptions.engine is 'connect'
			throw 'Unsupported database engine: ' + databaseOptions.engine
		return exports[databaseOptions.engine](databaseOptions.params)

	return exports
