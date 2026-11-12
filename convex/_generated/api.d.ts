/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as auth from "../auth.js";
import type * as backupSchema from "../backupSchema.js";
import type * as backups from "../backups.js";
import type * as http from "../http.js";
import type * as imports from "../imports.js";
import type * as lifecycle from "../lifecycle.js";
import type * as noteModel from "../noteModel.js";
import type * as sourceModel from "../sourceModel.js";
import type * as tracker from "../tracker.js";
import type * as trackerDocs from "../trackerDocs.js";
import type * as trackerModel from "../trackerModel.js";
import type * as trackerTypes from "../trackerTypes.js";
import type * as trackerValidation from "../trackerValidation.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  auth: typeof auth;
  backupSchema: typeof backupSchema;
  backups: typeof backups;
  http: typeof http;
  imports: typeof imports;
  lifecycle: typeof lifecycle;
  noteModel: typeof noteModel;
  sourceModel: typeof sourceModel;
  tracker: typeof tracker;
  trackerDocs: typeof trackerDocs;
  trackerModel: typeof trackerModel;
  trackerTypes: typeof trackerTypes;
  trackerValidation: typeof trackerValidation;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
