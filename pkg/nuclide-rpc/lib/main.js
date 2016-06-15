'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import fs from 'fs';
import nuclideUri from '../../nuclide-remote-uri';
import invariant from 'assert';
import Module from 'module';

import {generateProxy} from './proxy-generator';
import {parseServiceDefinition} from './service-parser';

// Proxy dependencies
import Rx from 'rxjs';
import {trackOperationTiming} from '../../nuclide-analytics';

import type {
  Definitions,
  ReturnKind,
  Type,
  Parameter,
} from './types';

export type RpcContext = {
  callRemoteFunction(functionName: string, returnType: ReturnKind, args: Object): any;
  callRemoteMethod(
    objectId: number,
    methodName: string,
    returnType: ReturnKind,
    args: Object
  ): any;
  createRemoteObject(
    interfaceName: string,
    thisArg: Object,
    unmarshalledArgs: Array<any>,
    argTypes: Array<Parameter>
  ): void;
  disposeRemoteObject(object: Object): Promise<void>;
  marshal(value: any, type: Type): any;
  unmarshal(value: any, type: Type): any;
  marshalArguments(
    args: Array<any>,
    argTypes: Array<Parameter>
  ): Promise<Object>;
  unmarshalArguments(
    args: Object,
    argTypes: Array<Parameter>
  ): Promise<Array<any>>;
};

export type ProxyFactory = (context: RpcContext) => Object;

/** Cache for definitions. */
const definitionsCache: Map<string, Definitions> = new Map();
/** Cache for remote proxies. */
const proxiesCache: Map<string, ProxyFactory> = new Map();

/**
 * Load the definitions, cached by their resolved file path.
 * @param definitionPath - The path to the definition file, relative to the module of
 *  the caller.
 * @returns - The Definitions that represents the API of the definiition file.
 */
export function getDefinitions(definitionPath: string): Definitions {
  if (!definitionsCache.has(definitionPath)) {
    definitionsCache.set(definitionPath, loadDefinitions(definitionPath));
  }
  const result = definitionsCache.get(definitionPath);
  invariant(result != null);
  return result;
}

function loadDefinitions(definitionPath: string): Definitions {
  const resolvedPath = resolvePath(definitionPath);
  return parseServiceDefinition(resolvedPath, fs.readFileSync(resolvedPath, 'utf8'));
}

/**
 * Get a proxy module for a given (service, client) pair. This function generates
 * the definitions if the they don't exist, and caches the proxy module if it has
 * already been generated before.
 * @param clientObject {RpcConnection} The client object that needs to be able to marhsal
 *   and unmarshal objects, as well as make RPC calls.
 * @returns - A proxy module that exports the API specified by the definition
 */
export function getProxy(
  serviceName: string,
  definitionPath: string,
  clientObject: RpcContext,
): any {
  if (!proxiesCache.has(definitionPath)) {
    proxiesCache.set(definitionPath, createProxyFactory(serviceName, false, definitionPath));
  }

  const factory = proxiesCache.get(definitionPath);
  invariant(factory != null);
  return factory(clientObject);
}

export function createProxyFactory(
  serviceName: string,
  preserveFunctionNames: boolean,
  definitionPath: string,
): ProxyFactory {
  const defs = getDefinitions(definitionPath);
  const code = generateProxy(serviceName, preserveFunctionNames, defs);
  const filename = nuclideUri.parsePath(definitionPath).name + 'Proxy.js';
  const m = loadCodeAsModule(code, filename);
  m.exports.inject(Rx.Observable, trackOperationTiming);

  return m.exports;
}

function loadCodeAsModule(code: string, filename: string): Module {
  const m = new Module();
  m.filename = m.id = nuclideUri.join(__dirname, filename);
  m.paths = []; // Prevent accidental requires by removing lookup paths.
  m._compile(code, filename);

  return m;
}

/**
 * Resolve definitionPath based on the caller's module, and fallback to
 * this file's module in case module.parent doesn't exist (we are using repl).
 * Note that `require('module')._resolveFilename(path, module)` is equivelent to
 * `require.resolve(path)` under the context of given module.
 */
function resolvePath(definitionPath: string): string {
  return Module._resolveFilename(definitionPath, module.parent ? module.parent : module);
}

// Export caches for testing.
export const __test__ = {
  definitionsCache,
  proxiesCache,
};
