import sonoma from "../../tracks/sonoma.json";
import sfBlock from "../../tracks/sf_block.json";

export interface TrackDef {
  name: string;
  track: [number, number][];
  center: [number, number];
  zoom: number;
  bearing: number;
  finishLine: [number, number];
  turns: { label: string; pos: [number, number] }[];
}

export const TRACKS: Record<string, TrackDef> = {
  sonoma: sonoma as TrackDef,
  sf_block: sfBlock as TrackDef,
};

export const DEFAULT_TRACK = "sonoma";

export function getTrack(id?: string): TrackDef {
  return TRACKS[id ?? DEFAULT_TRACK] ?? TRACKS[DEFAULT_TRACK];
}

export function getActiveTrack(): TrackDef {
  const params = new URLSearchParams(window.location.search);
  return getTrack(params.get("track") ?? undefined);
}
