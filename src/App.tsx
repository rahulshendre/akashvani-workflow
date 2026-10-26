import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Welcome from "./pages/Welcome.tsx";
import EditorHome from "./pages/EditorHome.tsx";
import Index from "./pages/Index.tsx";
import Setup from "./pages/Setup.tsx";
import DriveSetup from "./pages/DriveSetup.tsx";
import Join from "./pages/Join.tsx";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Welcome />} />
          <Route path="/editor" element={<EditorHome />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/drive-setup" element={<DriveSetup />} />
          <Route path="/join" element={<Join />} />
          <Route path="/pipeline" element={<Index />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
