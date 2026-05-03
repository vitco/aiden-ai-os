/**
 * tools/v4/index.ts — Tool registration helper.
 *
 * `registerReadOnlyTools(registry)` wires every Phase 7 read-only
 * wrapper.
 * `registerWriteTools(registry)` wires every Phase 8 write/execute
 * wrapper.
 * `registerAllTools(registry)` does both — call once at boot, after
 * the registry is created and before `AidenAgent` is constructed.
 *
 * Phase 9 layers the approval engine on top: every wrapper with
 * `mutates: true` is gated before its `execute` runs.
 *
 * Status: PHASE 8.
 */

import type { ToolRegistry } from '../../core/v4/toolRegistry';

import { webSearchTool } from './web/webSearch';
import { webFetchTool } from './web/webFetch';
import { webPageTool } from './web/webPage';
import { deepResearchTool } from './web/deepResearch';

import { fileReadTool } from './files/fileRead';
import { fileListTool } from './files/fileList';
import { fileWriteTool } from './files/fileWrite';
import { filePatchTool } from './files/filePatch';
import { fileDeleteTool } from './files/fileDelete';
import { fileMoveTool } from './files/fileMove';
import { fileCopyTool } from './files/fileCopy';

import { browserScreenshotTool } from './browser/browserScreenshot';
import { browserExtractTool } from './browser/browserExtract';
import { browserGetUrlTool } from './browser/browserGetUrl';
import { browserNavigateTool } from './browser/browserNavigate';
import { browserClickTool } from './browser/browserClick';
import { browserTypeTool } from './browser/browserType';
import { browserFillTool } from './browser/browserFill';
import { browserScrollTool } from './browser/browserScroll';
import { browserCloseTool } from './browser/browserClose';

import { sessionSearchTool } from './sessions/sessionSearch';
import { sessionListTool } from './sessions/sessionList';

import { skillsListTool } from './skills/skillsList';
import { makeLookupToolSchema } from './skills/lookupToolSchema';

import { systemInfoTool } from './system/systemInfo';
import { nowPlayingTool } from './system/nowPlaying';
import { naturalEventsTool } from './system/naturalEvents';

import { shellExecTool } from './terminal/shellExec';
import { executeCodeTool } from './executeCode';

import { processSpawnTool } from './process/processSpawn';
import { processListTool } from './process/processList';
import { processLogReadTool } from './process/processLogRead';
import { processKillTool } from './process/processKill';
import { processWaitTool } from './process/processWait';

/**
 * Register every read-only tool into `registry`. The
 * `lookup_tool_schema` tool needs a registry reference, so it's
 * registered LAST (after every other tool, so it can introspect
 * the full set).
 */
export function registerReadOnlyTools(registry: ToolRegistry): void {
  registry.register(webSearchTool);
  registry.register(webFetchTool);
  registry.register(webPageTool);
  registry.register(deepResearchTool);

  registry.register(fileReadTool);
  registry.register(fileListTool);

  registry.register(browserScreenshotTool);
  registry.register(browserExtractTool);
  registry.register(browserGetUrlTool);

  registry.register(sessionSearchTool);
  registry.register(sessionListTool);

  registry.register(skillsListTool);

  registry.register(systemInfoTool);
  registry.register(nowPlayingTool);
  registry.register(naturalEventsTool);

  registry.register(makeLookupToolSchema(registry));
}

/**
 * Register every Phase 8 write/execute tool. Phase 9 will gate
 * every `mutates: true` handler in this set behind the approval
 * engine — the registration order doesn't matter for that.
 */
export function registerWriteTools(registry: ToolRegistry): void {
  registry.register(fileWriteTool);
  registry.register(filePatchTool);
  registry.register(fileDeleteTool);
  registry.register(fileMoveTool);
  registry.register(fileCopyTool);

  registry.register(shellExecTool);

  registry.register(browserNavigateTool);
  registry.register(browserClickTool);
  registry.register(browserTypeTool);
  registry.register(browserFillTool);
  registry.register(browserScrollTool);
  registry.register(browserCloseTool);

  registry.register(executeCodeTool);

  registry.register(processSpawnTool);
  registry.register(processListTool);
  registry.register(processLogReadTool);
  registry.register(processKillTool);
  registry.register(processWaitTool);
}

/** Register every v4 tool. Most callers want this. */
export function registerAllTools(registry: ToolRegistry): void {
  registerReadOnlyTools(registry);
  registerWriteTools(registry);
}

export { webSearchTool } from './web/webSearch';
export { webFetchTool } from './web/webFetch';
export { webPageTool } from './web/webPage';
export { deepResearchTool } from './web/deepResearch';
export { fileReadTool } from './files/fileRead';
export { fileListTool } from './files/fileList';
export { fileWriteTool } from './files/fileWrite';
export { filePatchTool } from './files/filePatch';
export { fileDeleteTool } from './files/fileDelete';
export { fileMoveTool } from './files/fileMove';
export { fileCopyTool } from './files/fileCopy';
export { browserScreenshotTool } from './browser/browserScreenshot';
export { browserExtractTool } from './browser/browserExtract';
export { browserGetUrlTool } from './browser/browserGetUrl';
export { browserNavigateTool } from './browser/browserNavigate';
export { browserClickTool } from './browser/browserClick';
export { browserTypeTool } from './browser/browserType';
export { browserFillTool } from './browser/browserFill';
export { browserScrollTool } from './browser/browserScroll';
export { browserCloseTool } from './browser/browserClose';
export { sessionSearchTool } from './sessions/sessionSearch';
export { sessionListTool } from './sessions/sessionList';
export { skillsListTool } from './skills/skillsList';
export { makeLookupToolSchema } from './skills/lookupToolSchema';
export { systemInfoTool } from './system/systemInfo';
export { nowPlayingTool } from './system/nowPlaying';
export { naturalEventsTool } from './system/naturalEvents';
export { shellExecTool } from './terminal/shellExec';
export { executeCodeTool } from './executeCode';
export { processSpawnTool } from './process/processSpawn';
export { processListTool } from './process/processList';
export { processLogReadTool } from './process/processLogRead';
export { processKillTool } from './process/processKill';
export { processWaitTool } from './process/processWait';
