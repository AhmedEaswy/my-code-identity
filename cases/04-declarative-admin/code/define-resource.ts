import { createResourceApi } from './resource-api';
import { resolveRule } from './permissions';
import type { AnyRecord, Id, ResourceAction, ResourceDefinition } from './types';

/**
 * Declares an admin resource once and returns the object every page works from.
 *
 * The declaration is data: a slug, labels, permissions, a list config and an
 * optional form config. Everything else — the API client, the URL of each page,
 * the identity of a row, the permission rule behind each action — is derived
 * here, so adding a resource is one file and the pages stay generic.
 *
 * Conventions (each one overridable through `routes`, `endpoint`, `permissions`):
 *
 *   GET  /console/<slug>              list
 *   GET  /console/<slug>/:id          detail
 *   POST /console/<slug>              create
 *   POST /console/<slug>/:id          update
 *   POST /console/<slug>/:id/state    enable / disable
 *   permissions  <slug>_admin.{list,view,create,edit,delete,enable,disable}
 *   routes       /<slug>, /<slug>/new, /<slug>/:id/edit, /<slug>/:id
 */
export function defineResource<Row extends AnyRecord, Form extends AnyRecord = AnyRecord>(
	declaration: ResourceDefinition<Row, Form>
) {
	const root = declaration.routes?.list ?? `/${declaration.slug}`;

	return {
		...declaration,
		routes: {
			list: root,
			create: declaration.routes?.create ?? `${root}/new`,
			edit: declaration.routes?.edit ?? ((id: Id) => `${root}/${id}/edit`),
			detail: declaration.routes?.detail
		},
		api: createResourceApi<Row>(declaration.endpoint ?? declaration.slug, {
			listKey: declaration.listKey,
			itemKey: declaration.itemKey
		}),
		idOf: declaration.idOf ?? ((row: Row) => row.id as Id),
		labelOf: declaration.labelOf ?? ((row: Row) => String(row.name ?? '')),
		statusFlag: declaration.statusFlag ?? ('enabled' as const),
		/** Base of every cached query of this resource; invalidate it after a write. */
		cacheKey: [declaration.slug] as const,
		/** The permission names an action needs, or `false` when it is not offered. */
		rule: (action: ResourceAction) => resolveRule(declaration, action)
	};
}

export type Resource<Row extends AnyRecord = AnyRecord, Form extends AnyRecord = AnyRecord> =
	ReturnType<typeof defineResource<Row, Form>>;

export type AnyResource = Resource<AnyRecord, AnyRecord>;
