import { createContext } from "react";
import L from "leaflet";

export const CanvasContext = createContext<L.Canvas | null>(null)
