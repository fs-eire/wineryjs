// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

///////////////////////////////////////////////////////////////////////////////////////////////
/// This file defines the interfaces and an implementation of Object Context.
/// Object Context is the interface for object creation and named objects accessing.
///
/// Object context is introduced for constructing/providing an object and getting a named object under a request or application context.
/// It's necessary for object factories and providers to construct/provide objects with fields that point to some relational objets.
/// The type creator might know how to construct its own properties. But sometimes there are 
/// references in object of this type pointing to another type. 
///
/// e.g: {
///          "_type": "WorkGroup",
///          "name": "Some work group",
///          "members": [
///             "people:/a",
///             "people:/b"
///          ]
///      }
/// or
///      {
///          "_type" : "WorkGroup",
///          "name": "Some work group",
///          "members" : [
///             {"_type" : "People", "name": "Alex", "alias": "a"},
///             {"_type" : "People", "name": "Brian", "alias": "b"},
///          ]
///      }
///
/// In this case, constructor WorkGroup doesn't know how to construct People objects from URI or need to access constructor of type "People".
///
/// Another case is that objects might want to access named objects.
/// 
/// e.g: {
///          "_type": "Number"
///          "expression": "${web.maxPassagePerDoc} + 1"
///      }
/// 
/// In this case, the object want to consume a named object "web.maxPassagePerDoc" under current context.
///
/// Object context is introduced for helping these cases.
/// </summary>

import * as path from 'path';

import { TypeDef, TypeRegistry, ObjectFactory } from './object-type';
import { Uri, ProviderDef, ObjectProvider, ProviderRegistry } from './object-provider';
import { NamedObjectDef, NamedObject, NamedObjectRegistry, ObjectContextDependency } from './named-object';

/// <summary> Interface for ObjectContext </summary>
export interface ObjectContext {
    /// <summary> Create an object from input. </summary>
    /// <param name="input"> Input JS value. </param>
    /// <returns> Created object or null if failed. </returns>
    create(input: any): any;

    /// <summary> Get an named object from current context. </summary>
    /// <param name="name"> Name. case-sensitive. </param>
    /// <returns> Named object, or undefined if not found. </returns>
    get(name: string): NamedObject;

    /// <summary> Iterate each object on current context. Overriden object will only be visited once from higher scope. </summary>
    /// <param name="callback"> Callback on each named object. </summary>
    forEach(callback: (object: NamedObject) => void): void;

    /// <summary> Return the base directory of this object context. 
    /// User can use this directory to resolve files with relative paths.
    /// </summary>
    baseDir: string;
}

/// <summary> Scoped object context is an implementation of ObjectContext
/// Which holds object factory, object provider and named object collection at current scope.
/// The scoped object context also has a pointer to a larger scope context, when objects 
/// request cannot be handled at current scope, it will redirect to larger scope.
/// The chaining nature of scoped object context can be depicted as following:
///   +-------------------+        +-----------------------+         +----------------------+
///   |  Request scope    | parent |    Application        | parent  |      Global          |
///   |  ObjectContext    |------->| Scope ObjectContext   |-------> |  Scope ObjectContext |
///   +-------------------+        +-----------------------+         +----------------------+

export class ScopedObjectContext implements ObjectContext {
    private _scope: string;
    private _parent: ScopedObjectContext;
    private _def: ScopedObjectContextDef;

    private _objectFactory: ObjectFactory;
    private _objectProvider: ObjectProvider;
    private _namedObjects: NamedObjectRegistry;

    // Base directory used to resolve path.
    private _baseDir: string;

    /// <summary> Constructor. Throws exception if there is unrecongized type, protocol or cyclic named object dependency. </summary>
    /// <param name="scopeName"> Scope name that current object context applies to. Can be 'global', 'application', 'request'. </param>
    /// <param name="baseDir"> Base directory used to resolve relative file names. </param>
    /// <param name="parent"> Parent object context if exists. Application scope has parent scope as  null. </param>
    /// <param name="definition"> Definition for current object context. </param>
    public constructor(
        scopeName: string, 
        baseDir: string,
        parent: ScopedObjectContext, 
        definition: ScopedObjectContextDef) {
        
        this._scope = scopeName;
        this._baseDir = baseDir;
        this._def = definition;
        this._parent = parent;
        
        this._objectFactory = TypeRegistry.fromDefinition(definition.typeDefs, baseDir);
        this._objectProvider = ProviderRegistry.fromDefinition(definition.providerDefs, baseDir);
        this._namedObjects = NamedObjectRegistry.fromDefinition(scopeName, definition.namedObjectDefs, this);
    }

    /// <summary> Get scope name. </summary>
    public get scope(): string {
        return this._scope;
    }

    /// <summary> Get base directory. </summary>
    public get baseDir(): string {
        return this._baseDir;
    }

    /// <summary> Get definition for current object context. </summary>
    public get def(): ScopedObjectContextDef {
        return this._def;
    }

    /// <summary> Get parent context. </summary>
    public get parent(): ScopedObjectContext {
        return this._parent;
    }

    /// <summary> Iterator each object on current context. Overrided object will only be visited once from higher scope. </summary>
    /// <param name="callback"> Callback on each named object. </summary>
    public forEach(callback: (object: NamedObject) => void): void {
        let visited = new Set<string>();
        let currentScope: ScopedObjectContext = this;
        while (currentScope != null) {
            currentScope._namedObjects.forEach(object => {
                if (!visited.has(object.def.name)) {
                    visited.add(object.def.name);
                    callback(object);
                }
            });
            currentScope = currentScope._parent;
        }
    }

    /// <summary> Create JS value from an JS input.
    /// Exception is thrown when creation failed.
    /// </summary>
    /// <param name="input"> Any JS value as input </param>
    /// <returns> JS value constructed from input. </param>
    public create(input: any): any {
        if (Array.isArray(input)) {
            if (input.length == 0) {
                return input;
            }

            if (typeof input[0] == 'string') {
                let uris: Uri[] = [];
                let success = input.every((uri: string) => {
                    let ret = Uri.tryParse(uri);
                    if (ret.success) {
                        uris.push(ret.uri);
                    }
                    return ret.success;
                });
                if (!success) {
                    // If any of string is not URI, return itself.
                    return input;
                }
                let provider = this.selectProvider(uris[0], input);
                return provider.provide(uris, this);
            }
            else if (typeof input[0] === 'object') {
                if (input[0].hasOwnProperty('_type')) {
                    let typeName = input[0]['_type'];
                    let factory = this.selectFactory(typeName, input);
                    return factory.create(input, this);
                }
            }
            return input;
        }
        else if (typeof input === 'string') {
            let ret = Uri.tryParse(input);
            if (ret.success) {
                // Input is URI, select object provider from current scope to ancesters.
                let uri = ret.uri;
                let provider = this.selectProvider(uri, input);
                return provider.provide(uri, this);
            }
            else {
                // If a string is not URI, return itself.
                return input;
            }
        }
        else if (typeof input === 'object') {
            // Object with type.
            if (input.hasOwnProperty('_type')) {
                let typeName = input['_type'];
                let factory = this.selectFactory(typeName, input);
                return factory.create(input, this);
            }
        }
        return input;
    }

    /// <summary> Get an named object from current context </summary>
    /// <param name="name"> Name of the object. Case-sensitive. </param>
    /// <returns> NamedObject if found, otherwise undefined. </returns>
    public get(name: string): NamedObject {
        // We only support 2 level of scopes for now (app + per request)
        let namedObject = this._namedObjects.get(name);
        if (namedObject != null) {
            return namedObject;
        }
    
        // Not found at current level, try to find in parent.
        let depth = 1;
        let parent = this._parent;
        while (parent != null) {
            namedObject = parent._namedObjects.get(name);
            if (namedObject != null) {
                // We check if the named object returned from parent scope needs
                // to be invalidated in current scope. In that case we will re-create 
                // it and insert into cache in current scope.
                if (this.needsUpdate(namedObject, depth)) {
                    namedObject = {
                        def: namedObject.def,
                        value: this.create(namedObject.def.value),
                        scope: this._scope
                    };
                    
                    this._namedObjects.insert(namedObject);
                }
                return namedObject;
            }
            parent = parent._parent;
            ++depth;
        }
        return null;
    }

    /// <summary> Determine if a named object is sensitive to type/provider/named object override in current context,
    /// If yes, the object need to be updated.
    /// </summary>
    public needsUpdate(namedObject: NamedObject, depth: number): boolean {
        if (this._parent == null) {
            // Current scope is top scope, override never happens.
            return false;
        }
        let def = namedObject.def;
        // Object context override from request happened.
        let overrides = this._def;

        if (this._def.typeDefs.length != 0) {
            let typeDeps = def.dependencies.typeDependencies;
            for (let typeDep of typeDeps) {
                if (overrides.getTypeDef(typeDep, depth - 1) != null) {
                    return true;
                }
            }
        }
        if (this._def.providerDefs.length != 0) {
            let providerDeps = def.dependencies.protocolDependencies;
            for (let providerDep of providerDeps) {
                // Provide override happened.
                if (overrides.getProviderDef(providerDep, depth - 1) != null) {
                    return true;
                }
            };
        }
        if (this._def.namedObjectDefs.length != 0) {
            let objectDeps = def.dependencies.objectDependencies;
            for (let objectDep of objectDeps) {
                // Dependent named object override happened.
                if (overrides.getNamedObjectDef(objectDep, depth - 1) != null) {
                    return true;
                }
            }
        }
        return false;
    }

    /// <summary> Select object provider from current scope to ancesters. </summary>
    /// <param name='uri'> URI object. </param>
    /// <param name="input"> Any JS value as input. </param>
    private selectProvider(uri: Uri, input: any): ObjectProvider {
        if (uri != null) {
            for (let scope: ScopedObjectContext = this; scope != null; scope = scope._parent) {
                let provider = scope._objectProvider;
                if (provider != null && provider.supports(uri.protocol)) {
                    return provider;
                }
            }
        }
        throw new Error("Cannot create object, URI protocol '"
            + uri.protocol
            + "' is not supported. Input="
            + JSON.stringify(input));
    }

    /// <summary> Select object factory from current scope to ancesters. </summary>
    /// <param name='typeName'> Object type. </param>
    /// <param name="input"> Any JS value as input. </param>
    private selectFactory(typeName: string, input: any): ObjectFactory {
        for (let scope: ScopedObjectContext = this; scope != null; scope = scope._parent) {
            let factory = scope._objectFactory;
            if (factory != null && factory.supports(typeName)) {
                return factory;
            }
        }
        throw new Error("Cannot create object, _type '"
            + typeName
            + "' is not supported. Input="
            + JSON.stringify(input));
    }
}

/// <summary> Class for scoped object context definition. </summary>
export class ScopedObjectContextDef {
    /// <summary> Parent scoped object definition which is necessary to analze dependencies. </summary>
    private _parent: ScopedObjectContextDef;

    private _typeDefs: TypeDef[];
    private _typeNameToDef: Map<string, TypeDef>;

    private _providerDefs: ProviderDef[];
    private _protocolNameToDef: Map<string, ProviderDef>;

    private _objectDefs: NamedObjectDef[];
    private _objectNameToDef: Map<string, NamedObjectDef>;

    /// <summary> Constructor </summary>
    /// <param name="parentDefinition"> Definition for parent scope. Set to null if there is not parent scope. </param>
    /// <param name="typeDefs"> Object type definitions. </param>
    /// <param name="providerDefs"> Object provider definitions. </param>
    /// <param name="objectDefs"> Named object definitions. </param>
    /// <param name="enableDependencyAnalysis"> Whether enable dependency analysis on this context. 
    /// Currently we do for 'global' and 'application' scope, but not 'request' scope. </param>
    public constructor(
        parentDefinition: ScopedObjectContextDef,
        typeDefs: TypeDef[],
        providerDefs: ProviderDef[],
        objectDefs: NamedObjectDef[],
        enableDependencyAnalysis: boolean) {

        this._parent = parentDefinition;
        this._typeDefs = typeDefs;
        this._providerDefs = providerDefs;
        this._objectDefs = objectDefs;

        this._typeNameToDef = new Map<string, TypeDef>();
        for (let def of typeDefs) {
            this._typeNameToDef.set(def.typeName, def);
        }

        this._protocolNameToDef = new Map<string, ProviderDef>();
        for (let def of providerDefs) {
            this._protocolNameToDef.set(def.protocol, def);
        }

        this._objectNameToDef = new Map<string, NamedObjectDef>();
        for (let def of objectDefs) {
            this._objectNameToDef.set(def.name, def);
        }

        if (enableDependencyAnalysis) {
            this.analyzeNamedObjectDependencies();
        }
    }

    /// <summary> Parent scope context definition. </summary>
    public get parent(): ScopedObjectContextDef {
        return this._parent;
    }

    /// <summary> Get all type definition in current context. </summary>
    public get typeDefs(): TypeDef[] {
        return this._typeDefs;
    }

    /// <summary> Get type definition by type name. </summary>
    public getTypeDef(typeName: string, maxDepth: number = 32): TypeDef {
        
        let def = this._typeNameToDef.get(typeName);
        if (def == null && maxDepth > 0 && this._parent != null) {
            def = this._parent.getTypeDef(typeName, maxDepth - 1);
        }
        return def;
    }

    /// <summary> Get all provider definition in current context. </summary>
    public get providerDefs(): ProviderDef[] {
        return this._providerDefs;
    }

    /// <summary> Get provider definition by protocol name. </summary>
    public getProviderDef(protocolName: string, maxDepth: number = 32): ProviderDef {
        let def = this._protocolNameToDef.get(protocolName);
        if (def == null && maxDepth >0 && this._parent != null) {
            def = this._parent.getProviderDef(protocolName, maxDepth - 1);
        }
        return def;
    }

    /// <summary> Get all named object definition in current context. </summary>
    public get namedObjectDefs(): NamedObjectDef[] {
        return this._objectDefs;
    }

    /// <summary> Get named object definition by name. </summary>
    public getNamedObjectDef(name: string, maxDepth: number = 32): NamedObjectDef {
        let def = this._objectNameToDef.get(name);
        if (def == null && maxDepth > 0 && this._parent != null) {
            def = this._parent.getNamedObjectDef(name, maxDepth - 1);
        }
        return def;
    }

    /// <summary> Analyze named objects dependencies against type definition, provider definition and other named objects in current context. 
    /// After this call, contextDependency member of elements in 'defs' will be filled.
    /// Exception will be thrown if there are unrecoginized types/URI protocols or cyclic dependencies.
    /// </summary>
    private analyzeNamedObjectDependencies(): void {
        // First pass to analyze direct dependencies, do type check and protocol check.
        for (let def of this._objectDefs) {
            def.dependencies = new ObjectContextDependency();
            ScopedObjectContextDef.analyzeDirectDependencies(def.dependencies, def.value);

            // Do type check.
            let typeDeps = def.dependencies.typeDependencies;
            typeDeps.forEach(typeDep => {
                if (this.getTypeDef(typeDep) == null) {
                    throw new Error("Unrecoginized type '" + typeDep + "' found in named object '" + def.name + "'.");
                }
            });

            // Do URI provider check.
            let protocolDeps = def.dependencies.protocolDependencies;
            protocolDeps.forEach(protocolDep => {
                if (this.getProviderDef(protocolDep) == null) {
                    throw new Error("Unrecongized URI protocol '" + protocolDep + "' found in named object '" + def.name + "'.");
                }
            });
        }

        // Second pass to get closure from redirect/indirect dependencies.
        // Key: object name. Value: Closure of dependent object names.
        let resolved: Map<string, Set<string>> = new Map<string, Set<string>>();
        let toResolve: { unresolvedDeps: Set<string>, def: NamedObjectDef }[]  = [];

        // Create dependencies to resolve.
        for (let def of this._objectDefs) {
            let objectDeps = def.dependencies.objectDependencies;
            if (objectDeps.size != 0) {
                let unresolvedDeps = new Set<string>();
                objectDeps.forEach(depName => {
                    unresolvedDeps.add(depName);
                });
                toResolve.push({
                    unresolvedDeps: unresolvedDeps,
                    def: def
                });
            }
            else {
                resolved.set(def.name, objectDeps);
            }
        }

        // Multi-round resolution.
        while (toResolve.length != 0) {
            let remaining: { unresolvedDeps: Set<string>, def: NamedObjectDef }[] = [];
            let resolvedThisRound = 0;

            // One round to resolved each unresolved.
            for (let record of toResolve) {
                let unresolvedDeps = Object.keys(record.unresolvedDeps);
                // For each direct dependency, add their resolved dependency closure to current one.
                for (let dep of unresolvedDeps) {
                    let depClosure = resolved.get(dep);
                    if (depClosure != null) {
                        record.unresolvedDeps.delete(dep);
                        depClosure.forEach(depName => {
                            record.def.dependencies.setObjectDependency(depName);
                        });
                    }
                }
                // All unresolved dependencies are already resolved. 
                if (unresolvedDeps.length == 0) {
                    resolved.set(record.def.name, record.def.dependencies.objectDependencies);
                    ++resolvedThisRound;
                }
                else {
                    remaining.push(record);
                }
            }
            if (resolvedThisRound == 0) {
                throw new Error("Undefined named object or cyclic dependencies found: '"
                    + toResolve.map(obj => { return obj.def.name; }).join(","))
                + "'.";
            }
            toResolve = remaining;
        }
    }

    /// <summary> Analyze direct dependencies from a JS value. </summary>
    private static analyzeDirectDependencies(dep: ObjectContextDependency, jsValue: any): void {
        if (typeof jsValue === 'string') {
            let ret = Uri.tryParse(jsValue);
            if (ret.success) {
                dep.setProtocolDependency(ret.uri.protocol);
            }
        }
        else if (typeof jsValue === 'object') {
            let typeName = jsValue['_type'];
            if (typeName != null) {
                dep.setTypeDependency(typeName);
            }
            let propertyNames = Object.getOwnPropertyNames(jsValue);
            for (let propertyName of propertyNames) {
                ScopedObjectContextDef.analyzeDirectDependencies(dep, jsValue[propertyName]);
            }
        }
    }
}
