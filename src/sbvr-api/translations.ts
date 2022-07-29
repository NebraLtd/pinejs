import * as _ from 'lodash';
import {
	AbstractSqlModel,
	Relationship,
	ReferencedFieldNode,
	SelectNode,
	AliasNode,
	Definition,
	RelationshipInternalNode,
	RelationshipLeafNode,
	SelectQueryNode,
	NumberTypeNodes,
	BooleanTypeNodes,
	UnknownTypeNodes,
	NullNode,
} from '@balena/abstract-sql-compiler';
import { Dictionary } from './common-types';

type AliasValidNodeType =
	| ReferencedFieldNode
	| SelectQueryNode
	| NumberTypeNodes
	| BooleanTypeNodes
	| UnknownTypeNodes
	| NullNode;
const aliasFields = (
	abstractSqlModel: AbstractSqlModel,
	resourceName: string,
	aliases: Dictionary<string | AliasValidNodeType>,
): SelectNode[1] => {
	const fieldNames = abstractSqlModel.tables[resourceName].fields.map(
		({ fieldName }) => fieldName,
	);
	const nonexistentFields = _.difference(Object.keys(aliases), fieldNames, [
		'$toResource',
	]);
	if (nonexistentFields.length > 0) {
		throw new Error(
			`Tried to alias non-existent fields: '${nonexistentFields.join(', ')}'`,
		);
	}
	return fieldNames.map(
		(fieldName): AliasNode<AliasValidNodeType> | ReferencedFieldNode => {
			const alias = aliases[fieldName];
			if (alias) {
				if (typeof alias === 'string') {
					return ['Alias', ['ReferencedField', resourceName, alias], fieldName];
				}
				return ['Alias', alias, fieldName];
			}
			return ['ReferencedField', resourceName, fieldName];
		},
	);
};

const aliasResource = (
	abstractSqlModel: AbstractSqlModel,
	resourceName: string,
	toResource: string,
	aliases: Dictionary<string | ReferencedFieldNode>,
): Definition => {
	if (!abstractSqlModel.tables[toResource]) {
		throw new Error(`Tried to alias to a non-existent resource: ${toResource}`);
	}
	return {
		abstractSql: [
			'SelectQuery',
			['Select', aliasFields(abstractSqlModel, resourceName, aliases)],
			['From', ['Alias', ['Resource', toResource], resourceName]],
		],
	};
};

const namespaceRelationships = (
	relationships: Relationship,
	alias: string,
): void => {
	_.forEach(relationships, (relationship: Relationship, key) => {
		if (key === '$') {
			return;
		}

		let mapping = (relationship as RelationshipLeafNode).$;
		if (mapping != null && mapping.length === 2) {
			if (!key.includes('$')) {
				mapping = _.cloneDeep(mapping);
				mapping[1]![0] = `${mapping[1]![0]}$${alias}`;
				(relationships as RelationshipInternalNode)[`${key}$${alias}`] = {
					$: mapping,
				};
				delete (relationships as RelationshipInternalNode)[key];
			}
		}
		namespaceRelationships(relationship, alias);
	});
};

export const translateAbstractSqlModel = (
	fromAbstractSqlModel: AbstractSqlModel,
	toAbstractSqlModel: AbstractSqlModel,
	fromVersion: string,
	toVersion: string,
	definitions: Dictionary<
		| (Definition & { $toResource?: string })
		| Dictionary<string | ReferencedFieldNode>
	> = {},
): Dictionary<string> => {
	const isDefinition = (d: typeof definitions[string]): d is Definition =>
		'abstractSql' in d;

	const resourceRenames: Dictionary<string> = {};

	// TODO: why?
	fromAbstractSqlModel.rules = toAbstractSqlModel.rules;

	const fromKeys = Object.keys(fromAbstractSqlModel.tables);
	const nonexistentTables = _.difference(Object.keys(definitions), fromKeys);
	if (nonexistentTables.length > 0) {
		throw new Error(
			`Tried to define non-existent resources: '${nonexistentTables.join(
				', ',
			)}'`,
		);
	}
	_.forEach(toAbstractSqlModel.synonyms, (canonicalForm, synonym) => {
		// Don't double alias
		if (synonym.includes('$')) {
			fromAbstractSqlModel.synonyms[synonym] = canonicalForm;
		} else {
			fromAbstractSqlModel.synonyms[
				`${synonym}$${toVersion}`
			] = `${canonicalForm}$${toVersion}`;
		}
	});
	const relationships = _.cloneDeep(toAbstractSqlModel.relationships);
	namespaceRelationships(relationships, toVersion);
	_.forEach(relationships, (relationship, key) => {
		// Don't double alias
		if (!key.includes('$')) {
			key = `${key}$${toVersion}`;
		}
		fromAbstractSqlModel.relationships[key] = relationship;
	});

	// TODO: We also need to keep the original relationship refs to non $version resources
	// Also alias for ourselves to allow explicit referencing
	const aliasedFromRelationships = _.cloneDeep(
		fromAbstractSqlModel.relationships,
	);
	namespaceRelationships(aliasedFromRelationships, fromVersion);
	_.forEach(aliasedFromRelationships, (relationship, key) => {
		// Don't double alias
		if (!key.includes('$')) {
			key = `${key}$${fromVersion}`;
			fromAbstractSqlModel.relationships[key] = relationship;
		}
	});

	_.forEach(toAbstractSqlModel.tables, (table, key) => {
		// Don't double alias
		if (!key.includes('$')) {
			key = `${key}$${toVersion}`;
		}
		fromAbstractSqlModel.tables[key] = _.cloneDeep(table);
	});

	for (const key of fromKeys) {
		const definition = definitions[key];
		const table = fromAbstractSqlModel.tables[key];
		if (definition) {
			const { $toResource } = definition;
			const hasToResource = typeof $toResource === 'string';
			if (hasToResource) {
				resourceRenames[key] = `${$toResource}`;
			}
			const toResource = hasToResource ? $toResource : `${key}$${toVersion}`;
			// TODO: Should this use the toAbstractSqlModel?
			const toTable = fromAbstractSqlModel.tables[toResource];
			if (!toTable) {
				if (hasToResource) {
					throw new Error(`Unknown $toResource: '${toResource}'`);
				} else {
					throw new Error(`Missing $toResource: '${toResource}'`);
				}
			}
			table.modifyFields = _.cloneDeep(toTable.modifyFields ?? toTable.fields);
			table.modifyName = toTable.modifyName ?? toTable.name;
			if (isDefinition(definition)) {
				const d = { ...definition };
				delete d.$toResource;
				table.definition = d;
			} else {
				table.definition = aliasResource(
					fromAbstractSqlModel,
					key,
					toResource,
					definition,
				);
			}
		} else {
			const toTable = fromAbstractSqlModel.tables[`${key}$${toVersion}`];
			if (!toTable) {
				throw new Error(`Missing translation for: '${key}'`);
			}
			table.modifyFields = _.cloneDeep(toTable.modifyFields ?? toTable.fields);
			table.definition = {
				abstractSql: ['Resource', `${key}$${toVersion}`],
			};
		}
		// TODO: Why was this clone added?
		// Also alias the current version so it can be explicitly referenced
		fromAbstractSqlModel.tables[`${key}$${fromVersion}`] = _.clone(table);
	}

	return resourceRenames;
};
