import type {
	AbstractSqlModel,
	AbstractSqlTable,
} from '@balena/abstract-sql-compiler';

import * as sbvrTypes from '@balena/sbvr-types';
import { PermissionLookup } from '../sbvr-api/permissions';

import * as odataMetadata from 'odata-openapi';
// tslint:disable-next-line:no-var-requires
const { version }: { version: string } = require('../../package.json');

type dict = { [key: string]: any };
interface OdataCsdl {
	$Version: string;
	$EntityContainer: string;
	[key: string]: any;
}

interface ODataNameSpaceType {
	$Alias: string;
	'@Core.DefaultNamespace': boolean;
	[key: string]: any;
}
interface ODataEntityContainerType {
	$Kind: 'EntityContainer';
	[key: string]: any;
}

interface ODataEntityContainerEntryType {
	$Kind: 'EntityType' | 'ComplexType' | 'NavigationProperty';
	[key: string]: any;
}

interface AbstractModel {
	abstractSqlModel: AbstractSqlModel;
	permissionLookup: PermissionLookup;
}

/** OData JSON v4 CSDL Vocabulary constants
 *
 * http://docs.oasis-open.org/odata/odata-vocabularies/v4.0/odata-vocabularies-v4.0.html
 *
 */

const odataVocabularyReferences = {
	'https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Core.V1.json':
		{
			$Include: [
				{
					$Namespace: 'Org.OData.Core.V1',
					$Alias: 'Core',
					'@Core.DefaultNamespace': true,
				},
			],
		},
	'https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Measures.V1.json':
		{
			$Include: [
				{
					$Namespace: 'Org.OData.Measures.V1',
					$Alias: 'Measures',
				},
			],
		},
	'https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Aggregation.V1.json':
		{
			$Include: [
				{
					$Namespace: 'Org.OData.Aggregation.V1',
					$Alias: 'Aggregation',
				},
			],
		},
	'https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Capabilities.V1.json':
		{
			$Include: [
				{
					$Namespace: 'Org.OData.Capabilities.V1',
					$Alias: 'Capabilities',
				},
			],
		},
};

// https://github.com/oasis-tcs/odata-vocabularies/blob/main/vocabularies/Org.OData.Capabilities.V1.md
const restrictionsLookup = {
	update: {
		capability: 'UpdateRestrictions',
		ValueIdentifier: 'Updatable',
	},
	delete: {
		capability: 'DeleteRestrictions',
		ValueIdentifier: 'Deletable',
	},
	create: {
		capability: 'InsertRestrictions',
		ValueIdentifier: 'Insertable',
	},
	read: {
		capability: 'ReadRestrictions',
		ValueIdentifier: 'Readable',
	},
};

const getResourceName = (resourceName: string): string =>
	resourceName
		.split('-')
		.map((namePart) => namePart.split(' ').join('_'))
		.join('__');

const forEachUniqueTable = <T>(
	model: AbstractModel,
	callback: (
		tableName: string,
		table: AbstractSqlTable & { referenceScheme: string },
	) => T,
): T[] => {
	const usedTableNames: { [tableName: string]: true } = {};

	const result = [];

	for (const key of Object.keys(model.abstractSqlModel.tables)) {
		const table = model.abstractSqlModel.tables[key] as AbstractSqlTable & {
			referenceScheme: string;
		};
		if (
			typeof table !== 'string' &&
			!table.primitive &&
			!usedTableNames[table.name] &&
			model.permissionLookup
		) {
			usedTableNames[table.name] = true;
			result.push(callback(key, table));
		}
	}
	return result;
};

/**
 * parsing dictionary of vocabulary.resource.operation permissions string
 * into dictionary of resource to operation for later lookup
 */
const preparePermissionsLookup = (permissionLookup: PermissionLookup): dict => {
	const pathsAndOps: dict = {};

	for (const pathOpsAuths of Object.keys(permissionLookup)) {
		const [vocabulary, path, rule] = pathOpsAuths.split('.');

		pathsAndOps[vocabulary] = Object.assign(
			{ [path]: {} },
			pathsAndOps[vocabulary],
		);
		if (rule === 'all') {
			pathsAndOps[vocabulary][path] = Object.assign(
				{
					['read']: true,
					['create']: true,
					['update']: true,
					['delete']: true,
				},
				pathsAndOps[vocabulary][path],
			);
		} else if (rule === undefined) {
			// just true no operation to be named
			pathsAndOps[vocabulary][path] = true;
		} else {
			pathsAndOps[vocabulary][path] = Object.assign(
				{ [rule]: true },
				pathsAndOps[vocabulary][path],
			);
		}
	}

	return pathsAndOps;
};

export const generateODataMetadata = (
	vocabulary: string,
	abstractSqlModel: AbstractSqlModel,
	permissionsLookup?: PermissionLookup,
) => {
	const complexTypes: { [fieldType: string]: string } = {};
	const resolveDataType = (fieldType: string): string => {
		if (sbvrTypes[fieldType] == null) {
			console.error('Could not resolve type', fieldType);
			throw new Error('Could not resolve type' + fieldType);
		}
		const { complexType } = sbvrTypes[fieldType].types.odata;
		if (complexType != null) {
			complexTypes[fieldType] = complexType;
		}
		return sbvrTypes[fieldType].types.odata.name;
	};

	const prepPermissionsLookup = permissionsLookup
		? preparePermissionsLookup(permissionsLookup)
		: {};

	const model: AbstractModel = {
		abstractSqlModel,
		permissionLookup:
			prepPermissionsLookup[vocabulary] ?? prepPermissionsLookup['resource'],
	};

	let metaBalena: ODataNameSpaceType = {
		$Alias: vocabulary,
		'@Core.DefaultNamespace': true,
	};

	let metaBalenaEntries: dict = {};
	let entityContainerEntries: dict = {};
	forEachUniqueTable(
		model,
		(_key, { idField, name: resourceName, fields, referenceScheme }) => {
			resourceName = getResourceName(resourceName);
			// no path nor entity when permissions not contain resource
			if (
				!model?.permissionLookup?.[resourceName] &&
				!(model?.permissionLookup?.['all'] === true)
			) {
				return;
			}

			const uniqueTable: ODataEntityContainerEntryType = {
				$Kind: 'EntityType',
				$Key: [idField],
				'@Core.LongDescription':
					'{"x-ref-scheme": ["' + referenceScheme + '"]}',
			};

			fields
				.filter(({ dataType }) => dataType !== 'ForeignKey')
				.map(({ dataType, fieldName, required }) => {
					dataType = resolveDataType(dataType);
					fieldName = getResourceName(fieldName);

					uniqueTable[fieldName] = {
						$Type: dataType,
						$Nullable: !required,
						'@Core.Computed':
							fieldName === 'created_at' || fieldName === 'modified_at'
								? true
								: false,
					};
				});

			fields
				.filter(
					({ dataType, references }) =>
						dataType === 'ForeignKey' && references != null,
				)
				.map(({ fieldName, references, required }) => {
					const { resourceName: referencedResource } = references!;
					const referencedResourceName =
						model.abstractSqlModel.tables[referencedResource]?.name;
					const typeReference = referencedResourceName || referencedResource;

					fieldName = getResourceName(fieldName);
					uniqueTable[fieldName] = {
						$Kind: 'NavigationProperty',
						$Partner: resourceName,
						$Nullable: !required,
						$Type: vocabulary + '.' + getResourceName(typeReference),
					};
				});

			metaBalenaEntries[resourceName] = uniqueTable;

			entityContainerEntries[resourceName] = {
				$Collection: true,
				$Type: vocabulary + '.' + resourceName,
			};

			for (const [key, value] of Object.entries(restrictionsLookup)) {
				let capabilitiesEnabled = false;
				if (
					model?.permissionLookup?.[resourceName]?.hasOwnProperty(key) ||
					model?.permissionLookup?.['all'] === true
				) {
					capabilitiesEnabled = true;
				}
				const restriction = {
					['@Capabilities.' + value.capability]: {
						[value.ValueIdentifier]: capabilitiesEnabled,
					},
				};

				entityContainerEntries[resourceName] = Object.assign(
					entityContainerEntries[resourceName],
					restriction,
				);
			}
		},
	);

	metaBalenaEntries = Object.keys(metaBalenaEntries)
		.sort()
		.reduce((r, k) => ((r[k] = metaBalenaEntries[k]), r), {} as dict);

	metaBalena = { ...metaBalena, ...metaBalenaEntries };

	let oDataApi: ODataEntityContainerType = {
		$Kind: 'EntityContainer',
		'@Capabilities.BatchSupported': false,
	};

	const odataCsdl: OdataCsdl = {
		$Version: '4.01', // because of odata2openapi transformer has a hacky switch on === 4.0 that we don't want. Other checks are checking for >=4.0.
		$EntityContainer: vocabulary + '.ODataApi',
		$Reference: odataVocabularyReferences,
	};

	entityContainerEntries = Object.keys(entityContainerEntries)
		.sort()
		.reduce((r, k) => ((r[k] = entityContainerEntries[k]), r), {} as dict);

	oDataApi = { ...oDataApi, ...entityContainerEntries };

	metaBalena['ODataApi'] = oDataApi;

	odataCsdl[vocabulary] = metaBalena;

	return odataCsdl;
};

export const generateODataOpenAPI = (
	vocabulary: string,
	abstractSqlModel: AbstractSqlModel,
	permissionsLookup?: PermissionLookup,
	versionBasePathUrl: string = '',
	hostname: string = '',
) => {
	const odataCsdl = generateODataMetadata(
		vocabulary,
		abstractSqlModel,
		permissionsLookup,
	);
	const openAPIJson: any = odataMetadata.csdl2openapi(odataCsdl, {
		scheme: 'https',
		host: hostname,
		basePath: versionBasePathUrl,
		diagram: false,
		maxLevels: 5,
	});

	/**
	 * HACK
	 * Rewrite odata body response schema properties from `value:` to `d:`
	 * Currently pinejs is returning `d:`
	 * https://www.odata.org/documentation/odata-version-2-0/json-format/ (6. Representing Collections of Entries)
	 * https://www.odata.org/documentation/odata-version-3-0/json-verbose-format/ (6.1 Response body)
	 *
	 * New v4 odata specifies the body response with `value:`
	 * http://docs.oasis-open.org/odata/odata-json-format/v4.01/odata-json-format-v4.01.html#sec_IndividualPropertyorOperationRespons
	 *
	 * Used oasis translator generates openapi according to v4 spec (`value:`)
	 */

	Object.keys(openAPIJson.paths).forEach((i) => {
		if (
			openAPIJson?.paths[i]?.get?.responses?.['200']?.content?.[
				'application/json'
			]?.schema?.properties?.value
		) {
			openAPIJson.paths[i].get.responses['200'].content[
				'application/json'
			].schema.properties['d'] =
				openAPIJson.paths[i].get.responses['200'].content[
					'application/json'
				].schema.properties.value;
			delete openAPIJson.paths[i].get.responses['200'].content[
				'application/json'
			].schema.properties.value;
		}
	});

	return openAPIJson;
};

generateODataMetadata.version = version;
