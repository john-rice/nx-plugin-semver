import { logger, runExecutor } from '@nrwl/devkit';
import { concat, defer, of } from 'rxjs';
import { catchError, mapTo, switchMap } from 'rxjs/operators';

import { tryPushToGitRemote } from './utils/git';
import { resolveTagTemplate } from './utils/tag-template';
import { tryBump } from './utils/try-bump';
import { getProjectRoot } from './utils/workspace';
import { versionProject, versionWorkspace } from './version';

import type { ExecutorContext } from '@nrwl/devkit';
import type { CommonVersionOptions } from './version';
import type { VersionBuilderSchema } from './schema';

export default function version(
  {
    push,
    remote,
    dryRun,
    baseBranch,
    noVerify,
    syncVersions,
    skipRootChangelog,
    skipProjectChangelog,
    version,
    releaseAs,
    preid,
    changelogHeader,
    versionTagPrefix,
    postTargets,
  }: VersionBuilderSchema,
  context: ExecutorContext
): Promise<{ success: boolean }> {
  const workspaceRoot = context.root;
  const preset = 'angular';

  // @todo: refactor this in a dedicated function without a chained ternary.
  const tagPrefix =
    versionTagPrefix !== undefined
      ? resolveTagTemplate(versionTagPrefix, {
          target: context.projectName,
          projectName: context.projectName,
        })
      : syncVersions
      ? 'v'
      : `${context.projectName}-`;

  const projectRoot = getProjectRoot(context);
  const newVersion$ = tryBump({
    preset,
    projectRoot,
    tagPrefix,
    releaseType: releaseAs ?? version,
    preid,
  });

  const action$ = newVersion$.pipe(
    switchMap((newVersion) => {
      if (newVersion == null) {
        logger.info('⏹ Nothing changed since last release.');
        return of(undefined);
      }

      const options: CommonVersionOptions = {
        dryRun,
        newVersion,
        noVerify,
        preset,
        projectRoot,
        tagPrefix,
        changelogHeader,
      };

      const runStandardVersion$ = defer(() =>
        syncVersions
          ? versionWorkspace({
              ...options,
              skipRootChangelog,
              skipProjectChangelog,
              workspaceRoot,
            })
          : versionProject(options)
      );

      // @todo 4.0.0: remove this in favor of @jscutlery/semver:push postTarget.
      const pushToGitRemote$ = defer(() =>
        tryPushToGitRemote({
          branch: baseBranch,
          noVerify,
          remote,
        })
      );

      const executePostTargets$ = postTargets.map((postTarget) => {
        const options = normalizePostTarget(postTarget, context);
        return defer(async () => {
          const run = await runExecutor(...options);
          for await (const result of run) {
            if (!result.success) {
              throw new Error(`Something went wrong with post target: "${options[0].project}:${options[0].target}"`)
            }
          }
        });
      });

      return concat(
        runStandardVersion$,
        ...(push && dryRun === false ? [pushToGitRemote$] : []),
        ...(dryRun === false ? executePostTargets$ : [])
      );
    })
  );

  return action$
    .pipe(
      mapTo({ success: true }),
      catchError((error) => {
        logger.error(error.stack ?? error.toString());
        return of({ success: false });
      })
    )
    .toPromise();
}
