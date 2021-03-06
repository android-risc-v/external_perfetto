// Copyright (C) 2019 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {TRACE_MARGIN_TIME_S} from '../common/constants';
import {Engine} from '../common/engine';
import {slowlyCountRows} from '../common/query_iterator';
import {CurrentSearchResults, SearchSummary} from '../common/search_data';
import {TimeSpan} from '../common/time';

import {Controller} from './controller';
import {App} from './globals';

export function escapeQuery(s: string): string {
  // See https://www.sqlite.org/lang_expr.html#:~:text=A%20string%20constant
  s = s.replace(/\'/g, '\'\'');
  s = s.replace(/_/g, '^_');
  s = s.replace(/%/g, '^%');
  return `'%${s}%' escape '^'`;
}

export interface SearchControllerArgs {
  engine: Engine;
  app: App;
}

export class SearchController extends Controller<'main'> {
  private engine: Engine;
  private app: App;
  private previousSpan: TimeSpan;
  private previousResolution: number;
  private previousSearch: string;
  private updateInProgress: boolean;
  private setupInProgress: boolean;

  constructor(args: SearchControllerArgs) {
    super('main');
    this.engine = args.engine;
    this.app = args.app;
    this.previousSpan = new TimeSpan(0, 1);
    this.previousSearch = '';
    this.updateInProgress = false;
    this.setupInProgress = true;
    this.previousResolution = 1;
    this.setup().finally(() => {
      this.setupInProgress = false;
      this.run();
    });
  }

  private async setup() {
    await this.query(`create virtual table search_summary_window
      using window;`);
    await this.query(`create virtual table search_summary_sched_span using
      span_join(sched PARTITIONED cpu, search_summary_window);`);
    await this.query(`create virtual table search_summary_slice_span using
      span_join(slice PARTITIONED track_id, search_summary_window);`);
  }

  run() {
    if (this.setupInProgress || this.updateInProgress) {
      return;
    }

    const visibleState = this.app.state.frontendLocalState.visibleState;
    const omniboxState = this.app.state.frontendLocalState.omniboxState;
    if (visibleState === undefined || omniboxState === undefined ||
        omniboxState.mode === 'COMMAND') {
      return;
    }
    const newSpan = new TimeSpan(visibleState.startSec, visibleState.endSec);
    const newSearch = omniboxState.omnibox;
    let newResolution = visibleState.resolution;
    if (this.previousSpan.contains(newSpan) &&
        this.previousResolution === newResolution &&
        newSearch === this.previousSearch) {
      return;
    }
    this.previousSpan = new TimeSpan(
        Math.max(newSpan.start - newSpan.duration, -TRACE_MARGIN_TIME_S),
        newSpan.end + newSpan.duration);
    this.previousResolution = newResolution;
    this.previousSearch = newSearch;
    if (newSearch === '' || newSearch.length < 4) {
      this.app.publish('Search', {
        tsStarts: new Float64Array(0),
        tsEnds: new Float64Array(0),
        count: new Uint8Array(0),
      });
      this.app.publish('SearchResult', {
        sliceIds: new Float64Array(0),
        tsStarts: new Float64Array(0),
        utids: new Float64Array(0),
        sources: [],
        trackIds: [],
        totalResults: 0,
      });
      return;
    }

    let startNs = Math.round(newSpan.start * 1e9);
    let endNs = Math.round(newSpan.end * 1e9);

    // TODO(hjd): We shouldn't need to be so defensive here:
    if (!Number.isFinite(startNs)) {
      startNs = 0;
    }
    if (!Number.isFinite(endNs)) {
      endNs = 1;
    }
    if (!Number.isFinite(newResolution)) {
      newResolution = 1;
    }

    this.updateInProgress = true;
    const computeSummary =
        this.update(newSearch, startNs, endNs, newResolution).then(summary => {
          this.app.publish('Search', summary);
        });

    const computeResults =
        this.specificSearch(newSearch).then(searchResults => {
          this.app.publish('SearchResult', searchResults);
        });

    Promise.all([computeSummary, computeResults])
        .finally(() => {
          this.updateInProgress = false;
          this.run();
        });
  }

  onDestroy() {}

  private async update(
      search: string, startNs: number, endNs: number,
      resolution: number): Promise<SearchSummary> {
    const quantumNs = Math.round(resolution * 10 * 1e9);

    const searchLiteral = escapeQuery(search);

    startNs = Math.floor(startNs / quantumNs) * quantumNs;

    await this.query(`update search_summary_window set
      window_start=${startNs},
      window_dur=${endNs - startNs},
      quantum=${quantumNs}
      where rowid = 0;`);

    const rawUtidResult = await this.query(`select utid from thread join process
      using(upid) where thread.name like ${searchLiteral}
      or process.name like ${searchLiteral}`);

    const utids = [...rawUtidResult.columns[0].longValues!];

    const cpus = await this.engine.getCpus();
    const maxCpu = Math.max(...cpus, -1);

    const rawResult = await this.query(`
        select
          (quantum_ts * ${quantumNs} + ${startNs})/1e9 as tsStart,
          ((quantum_ts+1) * ${quantumNs} + ${startNs})/1e9 as tsEnd,
          min(count(*), 255) as count
          from (
              select
              quantum_ts
              from search_summary_sched_span
              where utid in (${utids.join(',')}) and cpu <= ${maxCpu}
            union all
              select
              quantum_ts
              from search_summary_slice_span
              where name like ${searchLiteral}
          )
          group by quantum_ts
          order by quantum_ts;`);

    const numRows = slowlyCountRows(rawResult);
    const summary = {
      tsStarts: new Float64Array(numRows),
      tsEnds: new Float64Array(numRows),
      count: new Uint8Array(numRows)
    };

    const columns = rawResult.columns;
    for (let row = 0; row < numRows; row++) {
      summary.tsStarts[row] = +columns[0].doubleValues![row];
      summary.tsEnds[row] = +columns[1].doubleValues![row];
      summary.count[row] = +columns[2].longValues![row];
    }
    return summary;
  }

  private async specificSearch(search: string) {
    const searchLiteral = escapeQuery(search);
    // TODO(hjd): we should avoid recomputing this every time. This will be
    // easier once the track table has entries for all the tracks.
    const cpuToTrackId = new Map();
    const engineTrackIdToTrackId = new Map();
    for (const track of Object.values(this.app.state.tracks)) {
      if (track.kind === 'CpuSliceTrack') {
        cpuToTrackId.set((track.config as {cpu: number}).cpu, track.id);
        continue;
      }
      if (track.kind === 'ChromeSliceTrack') {
        const config = (track.config as {trackId: number});
        engineTrackIdToTrackId.set(config.trackId, track.id);
        continue;
      }
      if (track.kind === 'AsyncSliceTrack') {
        const config = (track.config as {trackIds: number[]});
        for (const trackId of config.trackIds) {
          engineTrackIdToTrackId.set(trackId, track.id);
        }
        continue;
      }
    }

    const rawUtidResult = await this.query(`select utid from thread join process
    using(upid) where
      thread.name like ${searchLiteral} or
      process.name like ${searchLiteral}`);
    const utids = [...rawUtidResult.columns[0].longValues!];

    const rawResult = await this.query(`
    select
      id as slice_id,
      ts,
      'cpu' as source,
      cpu as source_id,
      utid
    from sched where utid in (${utids.join(',')})
    union
    select
      slice_id,
      ts,
      'track' as source,
      track_id as source_id,
      0 as utid
      from slice
      where slice.name like ${searchLiteral}
    union
    select
      slice_id,
      ts,
      'track' as source,
      track_id as source_id,
      0 as utid
      from slice
      join args using(arg_set_id)
      where string_value like ${searchLiteral}
    order by ts`);

    const numRows = slowlyCountRows(rawResult);

    const searchResults: CurrentSearchResults = {
      sliceIds: [],
      tsStarts: [],
      utids: [],
      trackIds: [],
      sources: [],
      totalResults: +numRows,
    };

    const columns = rawResult.columns;
    for (let row = 0; row < numRows; row++) {
      const source = columns[2].stringValues![row];
      const sourceId = +columns[3].longValues![row];
      let trackId = undefined;
      if (source === 'cpu') {
        trackId = cpuToTrackId.get(sourceId);
      } else if (source === 'track') {
        trackId = engineTrackIdToTrackId.get(sourceId);
      }

      if (trackId === undefined) {
        searchResults.totalResults--;
        continue;
      }

      searchResults.trackIds.push(trackId);
      searchResults.sources.push(source);
      searchResults.sliceIds.push(+columns[0].longValues![row]);
      searchResults.tsStarts.push(+columns[1].longValues![row]);
      searchResults.utids.push(+columns[4].longValues![row]);
    }
    return searchResults;
  }


  private async query(query: string) {
    const result = await this.engine.query(query);
    return result;
  }
}
