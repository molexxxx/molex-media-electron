import { useIPC } from './hooks/useIPC'
import { useAppStore } from './stores/appStore'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import Dashboard from './components/Dashboard'
import FileQueue from './components/FileQueue'
import ProcessingView from './components/ProcessingView'
import Settings from './components/Settings'
import LogViewer from './components/LogViewer'
import SetupWizard from './components/SetupWizard'

function App(): JSX.Element {
  useIPC()

  const { currentView, showSetup, ffmpegChecking } = useAppStore()

  if (ffmpegChecking) {
    return (
      <div className="h-full flex flex-col">
        <TitleBar />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-12 h-12 border-2 border-accent-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-surface-300 text-sm font-medium tracking-wide">Initializing molexMedia...</p>
          </div>
        </div>
      </div>
    )
  }

  if (showSetup) {
    return (
      <div className="h-full flex flex-col">
        <TitleBar />
        <SetupWizard />
      </div>
    )
  }

  const viewComponent = {
    dashboard: <Dashboard />,
    queue: <FileQueue />,
    processing: <ProcessingView />,
    settings: <Settings />,
    logs: <LogViewer />
  }[currentView]

  return (
    <div className="h-full flex flex-col">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto p-6">
          {viewComponent}
        </main>
      </div>
    </div>
  )
}

export default App
