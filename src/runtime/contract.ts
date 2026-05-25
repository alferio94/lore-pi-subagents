import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateRuntimeContract,
  type BuiltinAgentContract,
  type ContractAlias,
  type RuntimeContract,
} from "./contract-schema.ts";

let cachedContract: RuntimeContract | undefined;

export function defaultRuntimeContractPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "../../pi-runtime.contract.json");
}

export function loadRuntimeContract(contractPath = defaultRuntimeContractPath()): RuntimeContract {
  const raw = fs.readFileSync(contractPath, "utf8");
  return validateRuntimeContract(JSON.parse(raw) as unknown);
}

export function getRuntimeContract(): RuntimeContract {
  cachedContract ??= loadRuntimeContract();
  return cachedContract;
}

export function resetRuntimeContractCache(): void {
  cachedContract = undefined;
}

export function listBuiltinAgents(contract = getRuntimeContract()): BuiltinAgentContract[] {
  return [...contract.builtinCatalog.agents];
}

export function getBuiltinAgentContract(name: string, contract = getRuntimeContract()): BuiltinAgentContract | undefined {
  return contract.builtinCatalog.agents.find((agent) => agent.name === name);
}

export function listContractAliases(contract = getRuntimeContract()): ContractAlias[] {
  return [...contract.builtinCatalog.aliases];
}

export function getContractAliasMap(contract = getRuntimeContract()): ReadonlyMap<string, string> {
  return new Map(contract.builtinCatalog.aliases.map((alias) => [alias.alias, alias.target]));
}

export function resolveBuiltinAgentName(requestedName: string, contract = getRuntimeContract()): string {
  return getContractAliasMap(contract).get(requestedName) ?? requestedName;
}

export function getInstallPolicy(contract = getRuntimeContract()): RuntimeContract["installPolicy"] {
  return contract.installPolicy;
}

export function getPackageIdentity(contract = getRuntimeContract()): RuntimeContract["packageIdentity"] {
  return contract.packageIdentity;
}

export function getSourceLocator(contract = getRuntimeContract()): RuntimeContract["sourceLocator"] {
  return contract.sourceLocator;
}

export function getEntrypoint(contract = getRuntimeContract()): RuntimeContract["entrypoint"] {
  return contract.entrypoint;
}

export function getRuntimeInvariants(contract = getRuntimeContract()): RuntimeContract["runtimeInvariants"] {
  return contract.runtimeInvariants;
}
