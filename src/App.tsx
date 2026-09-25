import { useState } from "react";
import Lobby from "./components/Lobby";
import RoomView from "./components/RoomView";
import UpdateBanner from "./components/UpdateBanner";

interface RoomSession {
  roomName: string;
  displayName: string;
  password?: string;
  isCreator: boolean;
}

export default function App() {
  const [session, setSession] = useState<RoomSession | null>(null);

  const handleEnter = (params: RoomSession) => setSession(params);
  const handleLeave = () => setSession(null);

  return (
    <>
      {session ? (
        <RoomView
          roomName={session.roomName}
          displayName={session.displayName}
          password={session.password}
          isCreator={session.isCreator}
          onLeave={handleLeave}
        />
      ) : (
        <Lobby onEnter={handleEnter} />
      )}
      <UpdateBanner />
    </>
  );
}
