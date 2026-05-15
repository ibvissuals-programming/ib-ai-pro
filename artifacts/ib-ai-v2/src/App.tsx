import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import Login from "@/pages/Login";
import Signup from "@/pages/Signup";
import ChatApp from "@/pages/ChatApp";
import Landing from "@/pages/Landing";
import ImageTools from "@/pages/ImageTools";
import NotFound from "@/pages/not-found";
import { ProtectedRoute } from "@/auth/ProtectedRoute";
import { isAuthenticated } from "@/auth/authService";
import { ThemeProvider } from "@/contexts/ThemeContext";

function Router() {
  return (
    <Switch>
      <Route path="/">
        {isAuthenticated() ? <Redirect to="/chat" /> : <Landing />}
      </Route>
      <Route path="/login" component={Login} />
      <Route path="/signup" component={Signup} />
      <Route path="/chat">
        <ProtectedRoute>
          <ChatApp />
        </ProtectedRoute>
      </Route>
      <Route path="/image-tools">
        <ProtectedRoute>
          <ImageTools />
        </ProtectedRoute>
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}

export default App;
