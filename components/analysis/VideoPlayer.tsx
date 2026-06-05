import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { theme } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';

import { useVideoPlayer, VideoView } from 'expo-video';

export const VideoPlayer = ({ url }: { url?: string }) => {
  const player = useVideoPlayer(url || '', player => {
    player.loop = true;
    if (url) player.play();
  });

  if (!url) {
    return (
      <View style={styles.container}>
        <View style={styles.mockPlayer}>
          <Ionicons name="videocam-off" size={64} color={theme.colors.textSecondary} />
          <Text style={styles.text}>영상이 없습니다</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <VideoView 
        player={player} 
        style={styles.videoPlayer} 
        allowsFullscreen 
        allowsPictureInPicture 
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#000',
    borderRadius: theme.borderRadius.m,
    overflow: 'hidden',
    marginBottom: theme.spacing.l,
  },
  mockPlayer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  text: {
    ...theme.typography.h3,
    color: theme.colors.textPrimary,
    marginTop: theme.spacing.s,
  },
  subtext: {
    ...theme.typography.body2,
    color: theme.colors.textSecondary,
    marginTop: 4,
  },
  videoPlayer: {
    width: '100%',
    height: '100%',
  },
});
