import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Modal, TouchableOpacity } from 'react-native';
import { theme } from '../../constants/theme';
import { TicEventCard } from '../../components/analysis/TicEventCard';
import { TicEvent } from '../../types/tic-event';
import { GradientBackground } from '../../components/ui/GradientBackground';
import { useEventStore } from '../../stores/useEventStore';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';

// 별도의 Video 컴포넌트로 분리 (useVideoPlayer 훅 규칙을 위해)
function AnalysisVideoPlayer({ videoPath }: { videoPath: string }) {
  const player = useVideoPlayer(videoPath, player => {
    player.loop = true;
    player.play();
  });

  return (
    <VideoView 
      player={player} 
      style={styles.videoPlayer} 
      allowsFullscreen 
      allowsPictureInPicture 
    />
  );
}

export default function AnalysisScreen() {
  const events = useEventStore((state) => state.events);
  const [selectedEvent, setSelectedEvent] = useState<TicEvent | null>(null);

  const handlePressCard = (event: TicEvent) => {
    if (event.videoPath) {
      setSelectedEvent(event);
    }
  };

  return (
    <GradientBackground>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.sectionTitle}>── 상황 맥락 분석 ──</Text>
        
        {events.map((event) => (
          <TicEventCard 
            key={event.id} 
            event={event} 
            onPress={handlePressCard} 
          />
        ))}
        
        {events.length === 0 && (
          <Text style={styles.emptyText}>수집된 데이터가 없습니다.</Text>
        )}
      </ScrollView>

      {/* Video Player Modal */}
      <Modal
        visible={!!selectedEvent}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setSelectedEvent(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>기록 영상 확인</Text>
              <TouchableOpacity onPress={() => setSelectedEvent(null)}>
                <Ionicons name="close-circle" size={32} color={theme.colors.textPrimary} />
              </TouchableOpacity>
            </View>
            
            {selectedEvent?.videoPath && (
              <AnalysisVideoPlayer videoPath={selectedEvent.videoPath} />
            )}
          </View>
        </View>
      </Modal>
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: theme.spacing.m,
    paddingTop: theme.spacing.xxl,
    paddingBottom: 100, // 탭바 영역 확보
  },
  sectionTitle: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginBottom: theme.spacing.l,
  },
  emptyText: {
    ...theme.typography.body1,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginTop: theme.spacing.xl,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '90%',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.m,
    padding: theme.spacing.m,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.m,
  },
  modalTitle: {
    ...theme.typography.h3,
    color: theme.colors.textPrimary,
  },
  videoPlayer: {
    width: '100%',
    height: 300,
    backgroundColor: '#000',
    borderRadius: theme.borderRadius.s,
  },
});
