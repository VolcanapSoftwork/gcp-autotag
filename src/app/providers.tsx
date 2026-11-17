"use client";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";

const theme = createTheme({
  palette: { primary: { main: "#2f6f4f" }, secondary: { main: "#c62828" } },
  shape: { borderRadius: 6 },
  typography: { fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Noto Sans Thai', sans-serif" },
});

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}
