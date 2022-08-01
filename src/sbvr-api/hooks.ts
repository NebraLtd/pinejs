import type { OptionalField, Resolvable } from './common-types';
import type { Tx } from '../database-layer/db';
import type { ODataRequest, ParsedODataRequest } from './uri-parser';
import type { AnyObject } from 'pinejs-client-core';
import type { TypedError } from 'typed-error';
import type { SupportedMethod } from '@balena/odata-to-abstract-sql';

import * as _ from 'lodash';
import { settleMapSeries } from './control-flow';
import * as memoize from 'memoizee';
import {
	PinejsClient,
	User,
	ApiKey,
	resolveSynonym,
	getAbstractSqlModel,
	api,
	Response,
} from './sbvr-utils';

export interface HookReq {
	user?: User;
	apiKey?: ApiKey;
	method: string;
	url: string;
	query: AnyObject;
	params: AnyObject;
	body: AnyObject;
	custom?: AnyObject;
	tx?: Tx;
	hooks?: InstantiatedHooks;
}
export interface HookArgs {
	req: HookReq;
	request: ODataRequest;
	api: PinejsClient;
	tx?: Tx | undefined;
}
export type HookResponse = PromiseLike<any> | null | void;

export interface Hooks {
	PREPARSE?: (options: Omit<HookArgs, 'request' | 'api'>) => HookResponse;
	POSTPARSE?: (options: HookArgs) => HookResponse;
	PRERUN?: (options: HookArgs & { tx: Tx }) => HookResponse;
	/** These are run in reverse translation order from newest to oldest */
	POSTRUN?: (options: HookArgs & { tx: Tx; result: any }) => HookResponse;
	/** These are run in reverse translation order from newest to oldest */
	PRERESPOND?: (
		options: HookArgs & {
			tx: Tx;
			result: any;
			/** This can be mutated to modify the response sent to the client */
			response: Response;
			/** @deprecated Use the response object instead */
			data?: any;
		},
	) => HookResponse;
	/** These are run in reverse translation order from newest to oldest */
	'POSTRUN-ERROR'?: (
		options: HookArgs & { error: TypedError | any },
	) => HookResponse;
}
export type HookBlueprints = {
	[key in keyof Hooks]: Array<HookBlueprint<NonNullable<Hooks[key]>>>;
};
const hookNames: Array<keyof Hooks> = [
	'PREPARSE',
	'POSTPARSE',
	'PRERUN',
	'POSTRUN',
	'PRERESPOND',
	'POSTRUN-ERROR',
];
const isValidHook = (x: any): x is keyof Hooks => hookNames.includes(x);

export type RollbackAction = () => Resolvable<void>;
export type HookFn = (...args: any[]) => any;
export interface HookBlueprint<T extends HookFn> {
	hookFn: T;
	sideEffects: boolean;
	readOnlyTx: boolean;
}
export type InstantiatedHooks = {
	[key in keyof Hooks]: Array<Hook<NonNullable<Hooks[key]>>>;
};

class Hook<T extends HookFn> {
	private hookFn: HookBlueprint<T>['hookFn'];
	public readOnlyTx: HookBlueprint<T>['readOnlyTx'];
	constructor(hook: HookBlueprint<T>) {
		this.hookFn = hook.hookFn;
		this.readOnlyTx = hook.readOnlyTx;
	}

	public async run(...args: any[]) {
		await this.hookFn(...args);
	}
}

class SideEffectHook<T extends HookFn> extends Hook<T> {
	private rollbackFns: RollbackAction[] = [];
	private rolledBack: boolean = false;

	public registerRollback(fn: RollbackAction): void {
		if (this.rolledBack) {
			(async () => {
				try {
					await fn();
				} catch {
					// Ignore any errors in the rollback callback
				}
			})();
		} else {
			this.rollbackFns.push(fn);
		}
	}

	public async rollback() {
		// Don't try to call the rollback functions twice
		if (this.rolledBack) {
			return;
		}
		// set rolledBack to true straight away, so that if any rollback action
		// is registered after the rollback call, we will immediately execute it
		this.rolledBack = true;
		await settleMapSeries(this.rollbackFns, (fn) => fn());
	}
}

// The execution order of rollback actions is unspecified
export const rollbackRequestHooks = <T extends InstantiatedHooks>(
	versionedHooks: Array<[string, T]> | undefined,
): void => {
	if (versionedHooks == null) {
		return;
	}
	settleMapSeries(
		Object.values(versionedHooks).flatMap(
			([, v]): Array<Hook<HookFn>> => Object.values(v).flat(),
		),
		async (hook) => {
			if (hook instanceof SideEffectHook) {
				await hook.rollback();
			}
		},
	);
};

const instantiateHooks = (hooks: HookBlueprints): InstantiatedHooks =>
	_.mapValues(hooks, (typeHooks: Array<HookBlueprint<HookFn>>) => {
		return typeHooks.map((hook) => {
			if (hook.sideEffects) {
				return new SideEffectHook(hook);
			} else {
				return new Hook(hook);
			}
		});
	});

const mergeHooks = (a: HookBlueprints, b: HookBlueprints): HookBlueprints => {
	return _.mergeWith({}, a, b, (x, y) => {
		if (Array.isArray(x)) {
			return x.concat(y);
		}
	});
};
export type HookMethod = keyof typeof apiHooks;
const getResourceHooks = (vocabHooks: VocabHooks, resourceName?: string) => {
	if (vocabHooks == null) {
		return {};
	}
	// When getting the hooks list for the sake of PREPARSE hooks
	// we don't know the resourceName we'll be acting on yet
	if (resourceName == null) {
		return vocabHooks['all'];
	}
	return mergeHooks(vocabHooks[resourceName], vocabHooks['all']);
};
const getVocabHooks = (
	methodHooks: MethodHooks,
	vocabulary: string,
	resourceName: string | undefined,
	includeAllVocab: boolean,
) => {
	if (methodHooks == null) {
		return {};
	}
	const vocabHooks = getResourceHooks(methodHooks[vocabulary], resourceName);
	if (!includeAllVocab) {
		// Do not include `vocabulary='all'` hooks, useful for translated vocabularies
		return vocabHooks;
	}
	return mergeHooks(
		vocabHooks,
		getResourceHooks(methodHooks['all'], resourceName),
	);
};
const getMethodHooks = memoize(
	(
		method: SupportedMethod,
		vocabulary: string,
		resourceName: string | undefined,
		includeAllVocab: boolean,
	) =>
		mergeHooks(
			getVocabHooks(
				apiHooks[method],
				vocabulary,
				resourceName,
				includeAllVocab,
			),
			getVocabHooks(apiHooks['all'], vocabulary, resourceName, includeAllVocab),
		),
	{ primitive: true },
);
export const getHooks = (
	request: Pick<
		OptionalField<ParsedODataRequest, 'resourceName'>,
		'resourceName' | 'method' | 'vocabulary'
	>,
	includeAllVocab = true,
): InstantiatedHooks => {
	let { resourceName } = request;
	if (resourceName != null) {
		resourceName = resolveSynonym(
			request as Pick<
				ParsedODataRequest,
				'resourceName' | 'method' | 'vocabulary'
			>,
		).replace(/\$.*$/, '');
	}
	return instantiateHooks(
		getMethodHooks(
			request.method,
			request.vocabulary,
			resourceName,
			includeAllVocab,
		),
	);
};
getHooks.clear = () => getMethodHooks.clear();

interface VocabHooks {
	[resourceName: string]: HookBlueprints;
}
interface MethodHooks {
	[vocab: string]: VocabHooks;
}
const apiHooks = {
	all: {} as MethodHooks,
	GET: {} as MethodHooks,
	PUT: {} as MethodHooks,
	POST: {} as MethodHooks,
	PATCH: {} as MethodHooks,
	MERGE: {} as MethodHooks,
	DELETE: {} as MethodHooks,
	OPTIONS: {} as MethodHooks,
};

// Share hooks between merge and patch since they are the same operation,
// just MERGE was the OData intermediary until the HTTP spec added PATCH.
apiHooks.MERGE = apiHooks.PATCH;
export const addHook = (
	method: keyof typeof apiHooks,
	vocabulary: string,
	resourceName: string,
	hooks:
		| { [key in keyof Hooks]: HookBlueprint<NonNullable<Hooks[key]>> }
		| ({ [key in keyof Hooks]: NonNullable<Hooks[key]> } & {
				sideEffects: HookBlueprint<HookFn>['sideEffects'];
				readOnlyTx: HookBlueprint<HookFn>['readOnlyTx'];
		  }),
) => {
	const methodHooks = apiHooks[method];
	if (methodHooks == null) {
		throw new Error('Unsupported method: ' + method);
	}
	if (vocabulary === 'all') {
		if (resourceName !== 'all') {
			throw new Error(
				`When specifying a hook on all apis then you must also specify all resources, got: '${resourceName}'`,
			);
		}
	} else {
		let abstractSqlModel;
		try {
			abstractSqlModel = getAbstractSqlModel({ vocabulary });
		} catch {
			throw new Error('Unknown api root: ' + vocabulary);
		}
		if (resourceName !== 'all') {
			const origResourceName = resourceName;
			resourceName = resolveSynonym({ vocabulary, resourceName });
			if (abstractSqlModel.tables[resourceName] == null) {
				throw new Error(
					'Unknown resource for api root: ' +
						origResourceName +
						', ' +
						vocabulary,
				);
			}
		}
	}

	methodHooks[vocabulary] ??= {};

	const apiRootHooks = methodHooks[vocabulary];
	apiRootHooks[resourceName] ??= {};

	const resourceHooks = apiRootHooks[resourceName];

	if ('sideEffects' in hooks && 'readOnlyTx' in hooks) {
		const { sideEffects, readOnlyTx } = hooks;
		const blueprintedHooks: {
			[key in keyof Hooks]: HookBlueprint<NonNullable<Hooks[key]>>;
		} = {};
		for (const hookName of hookNames) {
			const hookFn: HookFn | undefined = hooks[hookName];
			if (hookFn != null) {
				blueprintedHooks[hookName] = {
					hookFn,
					sideEffects,
					readOnlyTx,
				};
			}
		}
		hooks = blueprintedHooks;
	}

	for (const hookType of Object.keys(hooks)) {
		if (!isValidHook(hookType)) {
			throw new Error('Unknown callback type: ' + hookType);
		}
		const hook = hooks[hookType];
		resourceHooks[hookType] ??= [];
		if (hook != null) {
			resourceHooks[hookType]!.push(hook);
		}
	}

	getHooks.clear();
};

export const addSideEffectHook = (
	method: HookMethod,
	apiRoot: string,
	resourceName: string,
	hooks: Hooks,
): void => {
	addHook(method, apiRoot, resourceName, {
		...hooks,
		sideEffects: true,
		readOnlyTx: false,
	});
};

export const addPureHook = (
	method: HookMethod,
	apiRoot: string,
	resourceName: string,
	hooks: Hooks,
): void => {
	addHook(method, apiRoot, resourceName, {
		...hooks,
		sideEffects: false,
		readOnlyTx: false,
	});
};

const defineApi = (version: string, args: HookArgs) => {
	const { req, tx } = args;
	Object.defineProperty(args, 'api', {
		get: _.once(() =>
			api[version].clone({
				passthrough: { req, tx },
			}),
		),
	});
};

export const runHooks = async <T extends keyof Hooks>(
	hookName: T,
	hooksList: Array<[string, InstantiatedHooks]> | undefined,
	args: Omit<Parameters<NonNullable<Hooks[T]>>[0], 'api'>,
) => {
	if (hooksList == null) {
		return;
	}
	const hooks = hooksList
		.map(([version, $hooks]): [string, InstantiatedHooks[T] | undefined] => [
			version,
			$hooks[hookName],
		])
		.filter(
			(v): v is [string, InstantiatedHooks[T]] =>
				v[1] != null && v[1].length > 0,
		);
	if (hooks.length === 0) {
		return;
	}
	if (['POSTRUN', 'PRERESPOND', 'POSTRUN-ERROR'].includes(hookName)) {
		// Any hooks after we "run" the query are executed in reverse order from newest to oldest
		// as they'll be translating the query results from "latest" backwards to the version that
		// was actually requested
		hooks.reverse();
	}

	let readOnlyArgs: typeof args;
	if (args.tx != null && !args.tx.isReadOnly()) {
		readOnlyArgs = { ...args, tx: args.tx.asReadOnly() };
	} else {
		// If we don't have a tx then read-only/writable is irrelevant
		readOnlyArgs = args;
	}
	for (const [version, versionHooks] of hooks) {
		const versionedArgs = _.clone(args);
		let versionedReadOnlyArgs = versionedArgs;
		if ((args as HookArgs).request != null) {
			defineApi(version, versionedArgs as HookArgs);
			if (args !== readOnlyArgs) {
				versionedReadOnlyArgs = _.clone(readOnlyArgs);
				// Only try to define a separate read-only api if it's different
				defineApi(version, versionedReadOnlyArgs as HookArgs);
			}
		}

		await Promise.all(
			(versionHooks as Array<Hook<HookFn>>).map(async (hook) => {
				await hook.run(hook.readOnlyTx ? versionedReadOnlyArgs : versionedArgs);
			}),
		);
	}
};
